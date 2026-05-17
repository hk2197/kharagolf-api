import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { Map, Wind, Pin, ChevronDown, ChevronUp, Watch, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast, toast as toastFn } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import {
  Tooltip as UITooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip';
import {
  SNAP_THRESHOLD_M,
  pointInRing,
  closestPointOnSegmentM,
  snapToFairway,
  findSnapTarget,
  haversineMeters,
  metersToYards,
  bearingDeg,
  metersPerPixel,
  type FairwayInfo,
  type SnapCandidateGreen,
  type SnapTarget,
} from '@workspace/snap-to-fairway';
import {
  playsLikeBreakdown,
  playsLikeYards,
  type PlaysLikeBreakdown,
} from '@workspace/golf-physics';

// Re-export the shared snap helpers so any existing imports of these names
// from this module keep working unchanged.
export {
  SNAP_THRESHOLD_M,
  pointInRing,
  closestPointOnSegmentM,
  snapToFairway,
  findSnapTarget,
};

type ToastHandle = ReturnType<typeof toastFn>;

const STANDARD_CLUBS = ["Dr","3W","5W","7W","2H","3H","4H","5H","3I","4I","5I","6I","7I","8I","9I","PW","GW","SW","LW","Putter"];
const LIE_TYPES = ["Tee","Fairway","Rough","Bunker","Hazard","Green"];

const BASE_URL = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
function apiUrl(path: string) { return `${BASE_URL}/api${path}`; }

const MAP_ZOOM = 17;
const IMG_W = 640;
const IMG_H = 380;

function windDegToLabel(deg: number) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

// Task #1638 — short relative-time label for the expanded undo history
// rows. Most edits are <60s old (the snackbar's auto-dismiss is 5s when
// collapsed) but the expanded list suspends auto-dismiss, so handle
// minutes / hours too.
function formatRelativeTime(diffMs: number): string {
  const s = Math.max(0, Math.floor(diffMs / 1000));
  if (s < 1) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

// Task #2031 — absolute clock time shown in a hover tooltip on each
// expanded undo-list row (e.g. "8:32:14 PM"). The relative label keeps
// ticking, but once it crosses "1m ago" / "2m ago" the player can pause
// on the row to see the exact moment the edit was made — closer to a
// proper audit log without bloating the visible row.
function formatAbsoluteTime(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

// `playsLikeBreakdown` / `playsLikeYards` / `PlaysLikeBreakdown` are now
// imported from `@workspace/golf-physics` (see imports above) so the web
// Hole Map panel, the mobile Hole Map sheet, the watch widget and the
// api-server `/playslike` endpoint all share one canonical implementation
// (Task #1965). The shared signature accepts optional temperature and
// altitude factors; this panel only ever passes wind + elevation, which is
// the documented behaviour for the watch-style preview.

interface HoleGps {
  holeNumber: number;
  par?: number | null;
  yardageWhite?: number | null;
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

interface WeatherData {
  windSpeed: number;
  windDirection: number;
  temperature: number;
}

interface HoleMapPanelProps {
  courseId: number;
  roundId: string | number;
  currentHole: number;
  par?: number | null;
  mode: 'general-play';
}

type ShotSource = 'watch' | 'phone' | 'manual' | 'scorer';

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
  source: ShotSource | null;
}

// Per-source visual styling for the round map overlay (Task #547).
// Watch shots are sky-blue (the established colour), phone auto-detect
// purple, scorer-entered amber. Manual entries usually have no GPS so
// they don't render on the map; if one ever does, fall back to grey.
const SHOT_SOURCE_STYLE: Record<ShotSource, { fill: string; stroke: string; label: string }> = {
  watch:  { fill: '#0EA5E9', stroke: '#082F49', label: 'Watch' },
  phone:  { fill: '#A855F7', stroke: '#3B0764', label: 'Phone' },
  scorer: { fill: '#F59E0B', stroke: '#78350F', label: 'Scorer' },
  manual: { fill: '#9CA3AF', stroke: '#374151', label: 'Manual' },
};
function shotStyle(src: ShotSource | null) {
  return SHOT_SOURCE_STYLE[src ?? 'manual'];
}

export default function HoleMapPanel({ courseId, roundId, currentHole, mode }: HoleMapPanelProps) {
  const [open, setOpen] = useState(false);
  const [mapboxToken, setMapboxToken] = useState<string | null>(null);
  const [holesGps, setHolesGps] = useState<HoleGps[]>([]);
  // Task #1645 — track which Mapbox URL has finished loading / errored
  // instead of using booleans plus a separate reset effect. Deriving
  // `imageLoaded` from the current `mapUrl` keeps the loaded state in
  // perfect sync with what's actually in the DOM, so quickly switching
  // holes or refreshing the token can never leave the spinner stuck on
  // top of an already-loaded image (the previous boolean reset was
  // scheduled in a passive effect and could lose a race with the very
  // next image load event).
  const [loadedMapUrl, setLoadedMapUrl] = useState<string | null>(null);
  const [erroredMapUrl, setErroredMapUrl] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [pinOffsets, setPinOffsets] = useState<Record<number, { lat: number; lng: number }>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hazards, setHazards] = useState<HazardInfo[]>([]);
  const [fairways, setFairways] = useState<FairwayInfo[]>([]);
  const [elevDiff, setElevDiff] = useState<number | null>(null);
  const [watchShots, setWatchShots] = useState<ShotRow[]>([]);
  const [selectedShotId, setSelectedShotId] = useState<number | null>(null);
  // Task #547 — let the player toggle which sources to overlay so the map
  // doesn't get cluttered when both watch and phone auto-detect are active.
  const [sourceFilter, setSourceFilter] = useState<Record<ShotSource, boolean>>({
    watch: true, phone: true, manual: true, scorer: true,
  });
  const [shotEditBusy, setShotEditBusy] = useState(false);
  // While dragging a shot marker, hold the live override position so the SVG
  // circle, hit-button, and trace polyline all follow the cursor before the
  // PATCH commits the new lat/lng (Task #705).
  const [shotDragPos, setShotDragPos] = useState<{ id: number; lat: number; lng: number } | null>(null);
  const shotDragRef = useRef<{
    id: number; startLat: number; startLng: number;
    startX: number; startY: number; moved: boolean;
  } | null>(null);
  // Set briefly when a drag finishes so the trailing onClick on the same
  // marker doesn't also toggle selection.
  const justDraggedShotRef = useRef(false);
  // Latest snap candidates, kept in refs so the once-mounted drag listener
  // closure always sees current values without needing to re-bind (Task #858).
  const currentHoleHazardsRef = useRef<HazardInfo[]>([]);
  const greenSnapPointsRef = useRef<SnapCandidateGreen[]>([]);
  const currentHoleFairwaysRef = useRef<FairwayInfo[]>([]);
  const { toast } = useToast();
  // Task #1177 — small history of recent shot edits so a player who batches
  // several changes can undo each one in turn. Earlier behaviour collapsed
  // the affordance to a single toast; the most recent edit replaced the
  // previous one so older edits became unrecoverable.
  // Task #1639 — raised the cap from 3 to 10 so power users in long rounds
  // can reach further back. The expanded list scrolls when entries exceed
  // the visible window (see renderUndoToast); older entries continue to
  // expire on the same TTL rules.
  const UNDO_STACK_LIMIT = 10;
  const UNDO_STACK_TTL_MS = 5000;
  const undoStackRef = useRef<Array<{ title: string; onUndo: () => void | Promise<unknown>; ts: number }>>([]);
  // Serialise the actual revert PATCHes so that rapid UNDO presses still
  // complete in strict LIFO order even when network latency would let
  // them resolve in a different order (Task #1177).
  const undoChainRef = useRef<Promise<void>>(Promise.resolve());
  const undoToastRef = useRef<{
    id: ToastHandle['id'];
    dismiss: ToastHandle['dismiss'];
    update: ToastHandle['update'];
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  // Forward declaration so renderUndoToast can reference popAndRunUndo via
  // a ref without ordering issues between the useCallbacks below.
  const popAndRunUndoRef = useRef<() => void>(() => {});
  // Task #1366 — when the player taps the "+N more" hint the banner expands
  // to show the full pending stack with per-entry Undo buttons. The expanded
  // state is held in a ref so the toast can re-render synchronously from
  // event handlers without waiting for a React state flush.
  const undoExpandedRef = useRef(false);
  const runUndoEntryRef = useRef<(idx: number) => void>(() => {});
  // Task #2032 — "Undo all" wipes the whole pending stack in one tap by
  // chaining every entry's undo callback through `undoChainRef` in newest →
  // oldest order. Held in a ref so renderUndoToast can wire the button
  // without depending on the callback's identity.
  const undoAllRef = useRef<() => void>(() => {});
  const dismissUndoToast = useCallback(() => {
    if (undoToastRef.current) {
      clearTimeout(undoToastRef.current.timer);
      undoToastRef.current.dismiss();
      undoToastRef.current = null;
    }
    undoStackRef.current = [];
    undoExpandedRef.current = false;
  }, []);

  // (Re)render the single undo banner from the current stack, resetting the
  // 5-second auto-dismiss timer. Empty stack tears the banner down. When
  // the banner is expanded (Task #1366) the description becomes a vertical
  // list of all pending edits in chronological order, each with its own
  // Undo button so the player can revert a specific older edit.
  const renderUndoToast = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) {
      if (undoToastRef.current) {
        clearTimeout(undoToastRef.current.timer);
        undoToastRef.current.dismiss();
        undoToastRef.current = null;
      }
      undoExpandedRef.current = false;
      return;
    }
    const top = stack[stack.length - 1];
    const extra = stack.length - 1;
    // Auto-collapse if there's nothing extra to show — keeps the banner
    // tidy after the user undoes everything down to a single entry.
    if (extra === 0) undoExpandedRef.current = false;
    const expanded = undoExpandedRef.current;
    let description: ReactNode = undefined;
    if (expanded) {
      // Task #1366 — chronological order (oldest → newest) so the list
      // reads top-to-bottom in the order the edits were made.
      // Task #1639 — when the stack carries many entries the list scrolls
      // inside the banner (max ~5 rows visible) instead of pushing the
      // toast off-screen. The 5-row cap keeps the banner unobtrusive
      // while still letting the player reach the older edits by scroll.
      // Task #1638 — each row also shows a relative timestamp ("just now",
      // "5s ago") so two adjacent rows that share a label (e.g. two "Shot
      // updated" entries) can be told apart. The label is recomputed on
      // every renderUndoToast() call; a 1s tick re-renders the toast so
      // the times stay fresh while the list is open.
      const now = Date.now();
      description = (
        <div className="mt-1 flex flex-col gap-1.5">
          {/* Task #2032 — "Undo all" pops the whole pending stack in one
              tap, reverting in newest → oldest order through the same
              serial chain as the per-row Undo buttons. Sits above the
              list so it's reachable without scrolling even when the
              stack is full. */}
          <div className="flex items-center justify-end">
            <button
              type="button"
              className="rounded border px-2 py-0.5 text-xs font-medium hover:bg-secondary"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                undoAllRef.current();
              }}
              aria-label={`Undo all ${stack.length} pending edits`}
            >
              Undo all
            </button>
          </div>
          <div className="flex max-h-48 flex-col gap-1.5 overflow-y-auto pr-1">
          {stack.map((entry, idx) => (
            <div
              key={idx}
              className="flex items-center justify-between gap-3 text-sm"
            >
              {/* Task #2031 — hovering a row reveals the absolute clock
                  time (e.g. "8:32:14 PM") in a tooltip so the player can
                  pin down the exact moment of an edit once the relative
                  label has rolled over to "1m ago" / "2m ago". */}
              <UITooltip>
                <TooltipTrigger asChild>
                  <span className="flex-1 min-w-0 flex items-baseline gap-2 cursor-help">
                    <span className="opacity-90 truncate">{entry.title}</span>
                    <span className="shrink-0 text-xs opacity-60 tabular-nums">
                      {formatRelativeTime(now - entry.ts)}
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs tabular-nums">
                  {formatAbsoluteTime(entry.ts)}
                </TooltipContent>
              </UITooltip>
              <button
                type="button"
                className="shrink-0 rounded border px-2 py-0.5 text-xs font-medium hover:bg-secondary"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  runUndoEntryRef.current(idx);
                }}
              >
                Undo
              </button>
            </div>
          ))}
          </div>
        </div>
      );
    } else if (extra > 0) {
      description = (
        <button
          type="button"
          className="text-left underline underline-offset-2 hover:opacity-100 opacity-90"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            undoExpandedRef.current = true;
            renderUndoToast();
          }}
          aria-label={`Show ${stack.length} pending edits`}
        >
          +{extra} more recent {extra === 1 ? 'edit' : 'edits'}
        </button>
      );
    }
    // Radix's ToastAction auto-closes the toast on click, but we manage the
    // banner ourselves so it can immediately re-render with the next entry
    // in the stack. preventDefault keeps Radix from closing it for us.
    // When the list is expanded the top "Undo" action becomes redundant
    // (each entry has its own button), so we swap it for "Hide" which
    // collapses the list back to the original compact banner.
    const action = expanded ? (
      <ToastAction altText="Hide history" onClick={(e) => {
        e.preventDefault();
        undoExpandedRef.current = false;
        renderUndoToast();
      }}>
        Hide
      </ToastAction>
    ) : (
      <ToastAction altText="Undo last edit" onClick={(e) => {
        e.preventDefault();
        popAndRunUndoRef.current();
      }}>
        Undo
      </ToastAction>
    );
    // When expanded, the player is actively reading the list, so don't
    // auto-dismiss — the X button (or Hide) is the explicit way out.
    const title = expanded ? 'Recent edits' : top.title;
    if (undoToastRef.current) {
      clearTimeout(undoToastRef.current.timer);
      undoToastRef.current.update({
        id: undoToastRef.current.id,
        title,
        description,
        action,
        open: true,
      });
    } else {
      const t = toast({ title, description, action });
      undoToastRef.current = {
        id: t.id,
        dismiss: t.dismiss,
        update: t.update,
        // Real timer is assigned just below; this placeholder keeps the
        // type non-nullable so we can reassign without an extra branch.
        timer: setTimeout(() => {}, 0),
      };
    }
    if (!expanded) {
      const timer = setTimeout(() => {
        undoStackRef.current = [];
        undoExpandedRef.current = false;
        if (undoToastRef.current) {
          undoToastRef.current.dismiss();
          undoToastRef.current = null;
        }
      }, UNDO_STACK_TTL_MS);
      undoToastRef.current.timer = timer;
    }
  }, [toast]);

  // Push an entry onto the undo stack and refresh the banner. Older entries
  // beyond UNDO_STACK_LIMIT fall off the bottom (FIFO).
  const pushUndoEntry = useCallback((title: string, onUndo: () => void) => {
    // Task #1638 — capture push time so the expanded list can render
    // a relative timestamp ("just now", "5s ago") next to each row.
    undoStackRef.current.push({ title, onUndo, ts: Date.now() });
    if (undoStackRef.current.length > UNDO_STACK_LIMIT) {
      undoStackRef.current.shift();
    }
    renderUndoToast();
  }, [renderUndoToast]);

  // Task #1638 — while the expanded history is open, re-render the toast
  // every second so the per-row relative timestamps tick forward (e.g.
  // "3s ago" → "4s ago"). Only ticks when expanded — when collapsed the
  // banner auto-dismisses after UNDO_STACK_TTL_MS and re-rendering would
  // reset that timer.
  useEffect(() => {
    const timer = setInterval(() => {
      if (
        undoExpandedRef.current &&
        undoStackRef.current.length > 0 &&
        undoToastRef.current
      ) {
        renderUndoToast();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [renderUndoToast]);

  // Pop the top entry, fire its undo callback, and either re-render the
  // banner with the next entry or tear it down if the stack is empty.
  // The actual revert PATCH is enqueued on `undoChainRef` so rapid UNDO
  // presses execute strictly in LIFO order even when each PATCH takes
  // a different amount of time on the wire (Task #1177).
  popAndRunUndoRef.current = () => {
    const entry = undoStackRef.current.pop();
    if (!entry) return;
    if (undoStackRef.current.length === 0) {
      undoExpandedRef.current = false;
      if (undoToastRef.current) {
        clearTimeout(undoToastRef.current.timer);
        undoToastRef.current.dismiss();
        undoToastRef.current = null;
      }
    } else {
      renderUndoToast();
    }
    undoChainRef.current = undoChainRef.current
      .then(() => Promise.resolve(entry.onUndo()))
      .then(() => undefined)
      .catch(() => undefined);
  };

  // Task #1366 — undo a specific entry by stack index (chronological:
  // 0 = oldest, length-1 = newest). Used by the per-entry Undo buttons in
  // the expanded history view, so the player can skip ahead and revert
  // an older edit without first stepping through the newer ones.
  // The revert PATCH is enqueued on the same serial chain as popAndRunUndo
  // so concurrent undos still complete in a deterministic order.
  runUndoEntryRef.current = (idx: number) => {
    const stack = undoStackRef.current;
    if (idx < 0 || idx >= stack.length) return;
    const entry = stack[idx];
    const next = stack.slice(0, idx).concat(stack.slice(idx + 1));
    undoStackRef.current = next;
    if (next.length === 0) {
      undoExpandedRef.current = false;
      if (undoToastRef.current) {
        clearTimeout(undoToastRef.current.timer);
        undoToastRef.current.dismiss();
        undoToastRef.current = null;
      }
    } else {
      renderUndoToast();
    }
    undoChainRef.current = undoChainRef.current
      .then(() => Promise.resolve(entry.onUndo()))
      .then(() => undefined)
      .catch(() => undefined);
  };

  // Task #2032 — pop the entire pending stack at once and chain every
  // entry's undo callback through the same serial chain in newest → oldest
  // order so each callback runs against the state it expects (the existing
  // single-undo flow already enforces strict LIFO; this just queues the
  // whole stack in one go). The banner tears down immediately because the
  // stack is empty after the call, mirroring the single-undo "last entry"
  // behaviour above.
  undoAllRef.current = () => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    // Snapshot newest → oldest before clearing so the closures below keep
    // a stable iteration order even if a stray push lands mid-chain.
    const reversed = stack.slice().reverse();
    undoStackRef.current = [];
    undoExpandedRef.current = false;
    if (undoToastRef.current) {
      clearTimeout(undoToastRef.current.timer);
      undoToastRef.current.dismiss();
      undoToastRef.current = null;
    }
    for (const entry of reversed) {
      undoChainRef.current = undoChainRef.current
        .then(() => Promise.resolve(entry.onUndo()))
        .then(() => undefined)
        .catch(() => undefined);
    }
  };

  // Clear any selected shot — and the undo history — when the user
  // navigates to a different hole. Per Task #1177, history is per-hole.
  useEffect(() => {
    setSelectedShotId(null);
    dismissUndoToast();
  }, [currentHole, dismissUndoToast]);

  // Collapsing the panel also wipes the pending undo history so it doesn't
  // resurface the next time the panel is reopened.
  useEffect(() => {
    if (!open) dismissUndoToast();
  }, [open, dismissUndoToast]);

  const imgRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const dragStart = useRef<{ x: number; y: number; lat: number; lng: number } | null>(null);

  const hole = holesGps.find(h => h.holeNumber === currentHole);
  const centreLat = hole?.greenCentreLat ? parseFloat(hole.greenCentreLat) : null;
  const centreLng = hole?.greenCentreLng ? parseFloat(hole.greenCentreLng) : null;
  const frontLat = hole?.greenFrontLat ? parseFloat(hole.greenFrontLat) : null;
  const frontLng = hole?.greenFrontLng ? parseFloat(hole.greenFrontLng) : null;
  const backLat = hole?.greenBackLat ? parseFloat(hole.greenBackLat) : null;
  const backLng = hole?.greenBackLng ? parseFloat(hole.greenBackLng) : null;

  const pinOffset = pinOffsets[currentHole] ?? { lat: 0, lng: 0 };
  const pinLat = centreLat !== null ? centreLat! + pinOffset.lat : null;
  const pinLng = centreLng !== null ? centreLng! + pinOffset.lng : null;
  const hasPinOffset = Math.abs(pinOffset.lat) > 0.000001 || Math.abs(pinOffset.lng) > 0.000001;

  // Fetch map token, hole GPS data, and hazard overlays
  useEffect(() => {
    fetch(apiUrl('/public/map-config'))
      .then(r => r.json()).then(d => setMapboxToken(d.token ?? null)).catch(() => {});
    fetch(apiUrl(`/public/courses/${courseId}/holes-gps`))
      .then(r => r.json()).then(d => Array.isArray(d) ? setHolesGps(d) : null).catch(() => {});
    fetch(apiUrl(`/public/courses/${courseId}/holes-hazards`))
      .then(r => r.json()).then(d => Array.isArray(d) ? setHazards(d) : null).catch(() => {});
    fetch(apiUrl(`/public/courses/${courseId}/holes-fairways`))
      .then(r => r.json()).then(d => Array.isArray(d) ? setFairways(d) : null).catch(() => {});
  }, [courseId]);

  // Fetch user geolocation and green elevation for slope/elevation plays-like adjustment
  useEffect(() => {
    if (!centreLat || !centreLng) return;
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(pos => {
      const { latitude: uLat, longitude: uLng } = pos.coords;
      fetch(`https://api.open-meteo.com/v1/elevation?latitude=${uLat},${centreLat}&longitude=${uLng},${centreLng}`)
        .then(r => r.json())
        .then((d: { elevation?: number[] }) => {
          if (d.elevation && d.elevation.length === 2) {
            setElevDiff(d.elevation[1] - d.elevation[0]);
          }
        })
        .catch(() => {});
    }, () => {});
  }, [centreLat, centreLng]);

  // Load watch-originated shots for this round (those with GPS coordinates)
  const reloadShots = useCallback(() => {
    if (!roundId) return;
    fetch(apiUrl(`/portal/rounds/1/shots?generalPlayRoundId=${roundId}`), { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then((groups: { hole: number; shots: ShotRow[] }[]) => {
        if (!Array.isArray(groups)) return;
        const flat: ShotRow[] = [];
        for (const g of groups) {
          if (Array.isArray(g.shots)) flat.push(...g.shots);
        }
        setWatchShots(flat);
      }).catch(() => {});
  }, [roundId]);

  useEffect(() => { reloadShots(); }, [reloadShots]);

  // Load saved pin positions
  useEffect(() => {
    if (!roundId || mode !== 'general-play') return;
    fetch(apiUrl(`/portal/general-play/${roundId}/pin-positions`), { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then((arr: Array<{ holeNumber: number; latOffset: string; lngOffset: string }>) => {
        if (!Array.isArray(arr)) return;
        const map: Record<number, { lat: number; lng: number }> = {};
        arr.forEach(p => { map[p.holeNumber] = { lat: parseFloat(p.latOffset), lng: parseFloat(p.lngOffset) }; });
        setPinOffsets(map);
      }).catch(() => {});
  }, [roundId, mode]);

  // Fetch weather when green GPS is available
  useEffect(() => {
    if (!centreLat || !centreLng) return;
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${centreLat}&longitude=${centreLng}&current_weather=true&wind_speed_unit=kmh`)
      .then(r => r.json())
      .then(d => {
        if (d.current_weather) {
          setWeather({ windSpeed: d.current_weather.windspeed, windDirection: d.current_weather.winddirection, temperature: d.current_weather.temperature });
        }
      }).catch(() => {});
  }, [centreLat, centreLng]);

  const buildMapUrl = () => {
    if (!mapboxToken || !centreLat || !centreLng) return null;
    return `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/${centreLng},${centreLat},${MAP_ZOOM}/${IMG_W}x${IMG_H}@2x?access_token=${mapboxToken}`;
  };

  // Convert pixel drag delta to lat/lng delta
  const pixelToLatLng = useCallback((dx: number, dy: number) => {
    if (!centreLat) return { dlat: 0, dlng: 0 };
    const mpp = metersPerPixel(centreLat, MAP_ZOOM);
    const scale = mpp / 111320;
    return { dlat: -dy * scale, dlng: dx * scale / Math.cos(centreLat * Math.PI / 180) };
  }, [centreLat]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!centreLat || !centreLng) return;
    isDragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, lat: pinOffset.lat, lng: pinOffset.lng };
    e.preventDefault();
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !dragStart.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    const { dlat, dlng } = pixelToLatLng(dx, dy);
    const newLat = dragStart.current.lat + dlat;
    const newLng = dragStart.current.lng + dlng;
    setPinOffsets(prev => ({ ...prev, [currentHole]: { lat: newLat, lng: newLng } }));
    setSaved(false);
  }, [currentHole, pixelToLatLng]);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
    dragStart.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => { window.removeEventListener('mousemove', handleMouseMove); window.removeEventListener('mouseup', handleMouseUp); };
  }, [handleMouseMove, handleMouseUp]);

  // Internal: PATCH without surfacing any success toast — used by undo
  // handlers themselves so they don't recursively offer "Undo" on the undo
  // action. Per Task #1177 we no longer surface a confirmation toast either,
  // because the shadcn toaster only keeps one toast at a time and a "reverted"
  // toast would evict the undo banner that's mid-way through showing the
  // remaining stack entries.
  const patchShotSilent = useCallback(async (id: number, body: Record<string, unknown>) => {
    setShotEditBusy(true);
    try {
      const res = await fetch(apiUrl(`/portal/shots/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (res.ok) {
        reloadShots();
        return true;
      }
      toast({ title: 'Failed to update shot', variant: 'destructive' });
      return false;
    } catch {
      toast({ title: 'Failed to update shot', variant: 'destructive' });
      return false;
    } finally { setShotEditBusy(false); }
  }, [reloadShots, toast]);

  // PATCH a shot field set (club/lieType/shotType/lat/lng) and reload list.
  // Defined before the drag listener effect so the effect can include it in
  // its dependency array without hitting a temporal dead zone (Task #705).
  // Captures the pre-edit values for the patched fields so a 5-second Undo
  // toast can revert them (Task #1009). Successive edits stack onto the undo
  // history (Task #1177) instead of replacing the previous undo entry.
  const patchShot = useCallback(async (id: number, body: Record<string, unknown>) => {
    // Snapshot the previous values for every field being changed so Undo can
    // restore them. Looked up from `watchShots` (the latest server state).
    const prev = watchShots.find(s => s.id === id);
    const prevValues: Record<string, unknown> = {};
    if (prev) {
      for (const key of Object.keys(body)) {
        const v = (prev as unknown as Record<string, unknown>)[key];
        // Numeric columns come back as strings from the server — coerce so
        // the undo PATCH validates as `typeof === "number"`.
        if ((key === 'latitude' || key === 'longitude' || key === 'distanceToPin' || key === 'distanceCarried') && typeof v === 'string') {
          prevValues[key] = parseFloat(v);
        } else {
          prevValues[key] = v ?? null;
        }
      }
    }
    setShotEditBusy(true);
    try {
      const res = await fetch(apiUrl(`/portal/shots/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (res.ok) {
        reloadShots();
        if (prev) {
          pushUndoEntry('Shot updated', () => patchShotSilent(id, prevValues));
        } else {
          toast({ title: 'Shot updated' });
        }
      } else {
        toast({ title: 'Failed to update shot', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Failed to update shot', variant: 'destructive' });
    } finally { setShotEditBusy(false); }
  }, [reloadShots, toast, watchShots, pushUndoEntry, patchShotSilent]);

  // Re-PATCH a shot back to its pre-drag coordinates (Task #859). Itself
  // an undo action, so it does not push a new undo entry — the stack pop
  // happens in popAndRunUndoRef before this fires.
  const undoMove = useCallback(async (id: number, prevLat: number, prevLng: number) => {
    setShotEditBusy(true);
    try {
      const res = await fetch(apiUrl(`/portal/shots/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ latitude: prevLat, longitude: prevLng }),
      });
      if (res.ok) {
        reloadShots();
        // No success toast: the undo banner is mid-render with the next
        // entry in the stack (Task #1177) and TOAST_LIMIT=1 means a new
        // toast here would evict it.
      } else {
        toast({ title: 'Failed to undo move', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Failed to undo move', variant: 'destructive' });
    } finally { setShotEditBusy(false); }
  }, [reloadShots, toast]);

  // PATCH a shot's new lat/lng after a drag, and push a 5-second "Undo"
  // entry onto the stack so the player can revert an accidental drop —
  // even if they make several moves in quick succession (Task #1177).
  const moveShot = useCallback(async (id: number, newLat: number, newLng: number, prevLat: number, prevLng: number, snappedLieType?: string) => {
    setShotEditBusy(true);
    try {
      const body: Record<string, unknown> = { latitude: newLat, longitude: newLng };
      if (snappedLieType) body.lieType = snappedLieType;
      const res = await fetch(apiUrl(`/portal/shots/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (res.ok) {
        reloadShots();
        pushUndoEntry('Shot moved', () => undoMove(id, prevLat, prevLng));
      } else {
        toast({ title: 'Failed to update shot', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Failed to update shot', variant: 'destructive' });
    } finally { setShotEditBusy(false); }
  }, [reloadShots, toast, undoMove, pushUndoEntry]);

  // Global listeners that drive the shot-marker drag (Task #705). Kept
  // separate from the pin drag so each can stop independently and we can
  // distinguish a "tap" (no movement) from a real drag.
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const d = shotDragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
      const { dlat, dlng } = pixelToLatLng(dx, dy);
      setShotDragPos({ id: d.id, lat: d.startLat + dlat, lng: d.startLng + dlng });
    }
    function onUp(e: MouseEvent) {
      const d = shotDragRef.current;
      if (!d) return;
      shotDragRef.current = null;
      setShotDragPos(null);
      if (!d.moved) return; // treat as a click — onClick will toggle selection
      justDraggedShotRef.current = true;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const { dlat, dlng } = pixelToLatLng(dx, dy);
      const dropLat = d.startLat + dlat;
      const dropLng = d.startLng + dlng;
      // Task #858 — snap drop to a nearby green or hazard and pre-fill lieType.
      const snap = findSnapTarget(
        dropLat, dropLng,
        currentHoleHazardsRef.current,
        greenSnapPointsRef.current,
        currentHoleFairwaysRef.current,
      );
      const finalLat = snap ? snap.lat : dropLat;
      const finalLng = snap ? snap.lng : dropLng;
      // Task #859 — show an Undo toast pointing back to the ORIGINAL pre-drag
      // coordinates so a snap-induced shift can be reverted too.
      moveShot(d.id, finalLat, finalLng, d.startLat, d.startLng, snap ? snap.lieType : undefined);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [pixelToLatLng, moveShot]);

  const savePin = async () => {
    setSaving(true);
    try {
      await fetch(apiUrl(`/portal/general-play/${roundId}/hole/${currentHole}/pin`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ latOffset: pinOffset.lat, lngOffset: pinOffset.lng }),
      });
      setSaved(true);
    } catch { /* non-fatal */ } finally { setSaving(false); }
  };

  const resetPin = () => {
    setPinOffsets(prev => ({ ...prev, [currentHole]: { lat: 0, lng: 0 } }));
    setSaved(false);
  };

  // Pixel position of pin on the image (IMG_W x IMG_H logical pixels, displayed at 100% container width)
  const pinPixelX = () => {
    if (!centreLat || !centreLng || !pinLat || !pinLng) return IMG_W / 2;
    const mpp = metersPerPixel(centreLat, MAP_ZOOM);
    const dlat = pinLat - centreLat;
    const dlng = pinLng - centreLng;
    const dx = dlng * Math.cos(centreLat * Math.PI / 180) * 111320 / mpp;
    const dy = -dlat * 111320 / mpp;
    return IMG_W / 2 + dx;
  };
  const pinPixelY = () => {
    if (!centreLat || !centreLng || !pinLat || !pinLng) return IMG_H / 2;
    const mpp = metersPerPixel(centreLat, MAP_ZOOM);
    const dlat = pinLat - centreLat;
    const dy = -dlat * 111320 / mpp;
    return IMG_H / 2 + dy;
  };

  // Resolve the (possibly drag-overridden) lat/lng for a shot so the SVG
  // marker, the trace polyline, and the hit-target all stay in sync while
  // the user is mid-drag.
  const shotLatLng = (s: ShotRow) => {
    if (shotDragPos && shotDragPos.id === s.id) return { lat: shotDragPos.lat, lng: shotDragPos.lng };
    return { lat: parseFloat(s.latitude!), lng: parseFloat(s.longitude!) };
  };

  // Convert a geo point to pixel on image
  const geoToPixel = (lat: number, lng: number) => {
    if (!centreLat || !centreLng) return null;
    const mpp = metersPerPixel(centreLat, MAP_ZOOM);
    const dlat = lat - centreLat;
    const dlng = lng - centreLng;
    const dx = dlng * Math.cos(centreLat * Math.PI / 180) * 111320 / mpp;
    const dy = -dlat * 111320 / mpp;
    return { x: IMG_W / 2 + dx, y: IMG_H / 2 + dy };
  };

  const mapUrl = buildMapUrl();
  // Derive load/error state from the URL the browser actually loaded
  // rather than tracking it as a boolean that needs a separate reset
  // effect (Task #1645). When `mapUrl` changes the derived flags flip
  // back to false in the same render that swaps the `<img src>`, so
  // there's no async window in which a stale "loaded" state could
  // briefly let the spinner sit on top of an already-rendered image.
  const imageLoaded = loadedMapUrl !== null && loadedMapUrl === mapUrl;
  const imageError = erroredMapUrl !== null && erroredMapUrl === mapUrl;
  const hasGps = centreLat !== null && centreLng !== null;

  // Distance measurements (from green front/back to centre for scale info)
  const distCentreToFront = (frontLat && frontLng && centreLat && centreLng)
    ? metersToYards(haversineMeters(centreLat, centreLng, frontLat, frontLng)) : null;
  const distCentreToBack = (backLat && backLng && centreLat && centreLng)
    ? metersToYards(haversineMeters(centreLat, centreLng, backLat, backLng)) : null;

  // Bearing from green front to green back (approx shot direction)
  const shotBearing = (frontLat && frontLng && backLat && backLng)
    ? bearingDeg(frontLat, frontLng, backLat, backLng) : null;

  // Wind + elevation plays-like yardage with per-factor breakdown so the UI
  // can surface "plays X yds" headline plus a hover tooltip showing wind /
  // elevation contributions (Task #562 — phone parity).
  const rawYardage = hole?.yardageWhite ?? 0;
  const playsLikeBd = (rawYardage && weather && shotBearing !== null)
    ? playsLikeBreakdown(rawYardage, weather.windSpeed, weather.windDirection, shotBearing, elevDiff ?? undefined) : null;
  const playsLike = playsLikeBd?.playsLikeYards ?? null;

  // Hazards for the current hole
  const currentHoleHazards = hazards.filter(hz => hz.holeNumber === currentHole);
  const currentHoleFairways = fairways.filter(fw => fw.holeNumber === currentHole);

  // Snap targets — green centre/front/back, used for hint + drop-snap (Task #858).
  const greenSnapPoints: SnapCandidateGreen[] = [];
  if (centreLat !== null && centreLng !== null) greenSnapPoints.push({ lat: centreLat, lng: centreLng, label: 'Green centre' });
  if (frontLat !== null && frontLng !== null) greenSnapPoints.push({ lat: frontLat, lng: frontLng, label: 'Green front' });
  if (backLat !== null && backLng !== null) greenSnapPoints.push({ lat: backLat, lng: backLng, label: 'Green back' });
  currentHoleHazardsRef.current = currentHoleHazards;
  greenSnapPointsRef.current = greenSnapPoints;
  currentHoleFairwaysRef.current = currentHoleFairways;

  // Active snap target while a shot is mid-drag — drives the visual hint.
  const activeSnap: SnapTarget | null = shotDragPos
    ? findSnapTarget(shotDragPos.lat, shotDragPos.lng, currentHoleHazards, greenSnapPoints, currentHoleFairways)
    : null;

  // Shots on this hole — restricted to those with a GPS waypoint and to the
  // sources currently enabled in the legend filter (Task #547). Sorted by
  // shotNumber so consecutive shots can be joined with a polyline.
  const holeShots = watchShots
    .filter(s => s.holeNumber === currentHole && s.latitude !== null && s.longitude !== null)
    .filter(s => sourceFilter[(s.source ?? 'manual') as ShotSource])
    .sort((a, b) => (a.shotNumber ?? 0) - (b.shotNumber ?? 0));

  // Per-source counts for the legend (across ALL hole shots, not just the
  // currently filtered set, so the player can see what's being hidden).
  const holeShotsAll = watchShots.filter(s => s.holeNumber === currentHole && s.latitude !== null && s.longitude !== null);
  const sourceCounts = holeShotsAll.reduce<Record<ShotSource, number>>((acc, s) => {
    const src = (s.source ?? 'manual') as ShotSource;
    acc[src] = (acc[src] ?? 0) + 1;
    return acc;
  }, { watch: 0, phone: 0, manual: 0, scorer: 0 });

  // Carry distance between consecutive shots, in yards.
  function carryYards(idx: number): number | null {
    if (idx <= 0) return null;
    const prev = holeShots[idx - 1];
    const cur = holeShots[idx];
    if (!prev?.latitude || !prev?.longitude || !cur?.latitude || !cur?.longitude) return null;
    const m = haversineMeters(parseFloat(prev.latitude), parseFloat(prev.longitude),
                              parseFloat(cur.latitude), parseFloat(cur.longitude));
    return metersToYards(m);
  }

  const selectedShot = holeShots.find(s => s.id === selectedShotId) ?? null;

  // POST a snapshot back to the server to recreate a previously-deleted
  // shot. The new row gets a fresh id; the round/hole sequence is shifted so
  // the restored shot lands at its original shotNumber (Task #1009). Itself
  // an undo action — does not touch the undo stack (the popping happened
  // upstream in popAndRunUndoRef).
  async function restoreShot(snapshot: Record<string, unknown>) {
    setShotEditBusy(true);
    try {
      const res = await fetch(apiUrl('/portal/shots/restore'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(snapshot),
      });
      if (res.ok) {
        reloadShots();
        // No success toast: the undo banner may be mid-render with the next
        // entry in the stack (Task #1177) and TOAST_LIMIT=1 means a new
        // toast here would evict it.
      } else {
        toast({ title: 'Failed to restore shot', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Failed to restore shot', variant: 'destructive' });
    } finally { setShotEditBusy(false); }
  }

  async function deleteShot(id: number) {
    setShotEditBusy(true);
    try {
      const res = await fetch(apiUrl(`/portal/shots/${id}`), { method: 'DELETE', credentials: 'include' });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        setSelectedShotId(null);
        reloadShots();
        // Task #1009 — server returns the deleted row so we can offer Undo.
        const snap = (data as { deletedShot?: Record<string, unknown> }).deletedShot;
        if (snap) {
          // Tag the restore payload with general-play / tournament context so
          // the server can re-attach the shot to the right player or user.
          pushUndoEntry('Shot deleted', () => restoreShot(snap));
        } else {
          toast({ title: 'Shot deleted' });
        }
      } else {
        toast({ title: 'Failed to delete shot', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Failed to delete shot', variant: 'destructive' });
    } finally { setShotEditBusy(false); }
  }

  return (
    <div className="mb-4 rounded-xl border border-white/10 overflow-hidden bg-[#0d1724]">
      {/* Collapsible header */}
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/5 transition-colors"
        onClick={() => setOpen(v => !v)}
      >
        <div className="flex items-center gap-2">
          <Map className="w-4 h-4 text-[#C9A84C]" />
          <span className="text-sm font-medium text-white/80">Hole Map</span>
          {hasPinOffset && <span className="text-xs text-[#C9A84C]/70 ml-1">· Pin set</span>}
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-white/40" /> : <ChevronDown className="w-4 h-4 text-white/40" />}
      </button>

      {open && (
        <div>
          {!hasGps ? (
            <div className="px-4 pb-4 text-center text-white/30 text-sm py-8">
              No GPS data available for this hole.
              <br />
              <span className="text-xs">Ask your club admin to add green coordinates.</span>
            </div>
          ) : (
            <>
              {/* Map image area */}
              <div
                ref={imgRef}
                className="relative w-full select-none"
                style={{ paddingBottom: `${(IMG_H / IMG_W) * 100}%`, cursor: 'crosshair' }}
                onMouseDown={handleMouseDown}
              >
                <div className="absolute inset-0">
                  {mapUrl ? (
                    <>
                      <img
                        src={mapUrl}
                        alt={`Hole ${currentHole} satellite view`}
                        className="w-full h-full object-cover"
                        onLoad={() => setLoadedMapUrl(mapUrl)}
                        onError={() => setErroredMapUrl(mapUrl)}
                        draggable={false}
                      />
                      {!imageLoaded && !imageError && (
                        <div className="absolute inset-0 flex items-center justify-center bg-[#0d1724]">
                          <div className="w-6 h-6 border-2 border-[#C9A84C]/40 border-t-[#C9A84C] rounded-full animate-spin" />
                        </div>
                      )}
                      {imageError && (
                        <div className="absolute inset-0 flex items-center justify-center bg-[#0d1724] text-white/30 text-sm">
                          Satellite image unavailable
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center bg-[#111] text-white/20 text-sm">
                      No Mapbox token configured
                    </div>
                  )}

                  {/* SVG overlays */}
                  {imageLoaded && (
                    <svg
                      className="absolute inset-0 w-full h-full pointer-events-none"
                      viewBox={`0 0 ${IMG_W} ${IMG_H}`}
                      preserveAspectRatio="none"
                    >
                      {/* Fairway overlays — rendered first so hazards / shot
                          markers stay on top. Polygons get a soft green fill +
                          outline, LineString centrelines render as a thin
                          dashed line. */}
                      {currentHoleFairways.map((fw, fi) => {
                        const g = fw.geometry;
                        if (!g || !g.coordinates) return null;
                        const polygons: [number, number][][] = [];
                        const lines: [number, number][][] = [];
                        if (g.type === 'Polygon') {
                          const c = g.coordinates as [number, number][][];
                          if (Array.isArray(c) && c.length > 0 && Array.isArray(c[0])) polygons.push(c[0]);
                        } else if (g.type === 'MultiPolygon') {
                          const c = g.coordinates as [number, number][][][];
                          if (Array.isArray(c)) for (const poly of c) {
                            if (Array.isArray(poly) && poly.length > 0 && Array.isArray(poly[0])) polygons.push(poly[0]);
                          }
                        } else if (g.type === 'LineString') {
                          const c = g.coordinates as [number, number][];
                          if (Array.isArray(c)) lines.push(c);
                        }
                        const ringToPoints = (ring: [number, number][]) => {
                          const pts: string[] = [];
                          for (const [lng, lat] of ring) {
                            const p = geoToPixel(lat, lng);
                            if (p) pts.push(`${p.x},${p.y}`);
                          }
                          return pts.join(' ');
                        };
                        return (
                          <g key={`fw-${fi}`}>
                            {polygons.map((ring, ri) => ring.length >= 3 ? (
                              <polygon
                                key={`fw-${fi}-p-${ri}`}
                                points={ringToPoints(ring)}
                                fill="rgba(34,197,94,0.18)"
                                stroke="rgba(34,197,94,0.55)"
                                strokeWidth={1.2}
                              />
                            ) : null)}
                            {lines.map((line, li) => line.length >= 2 ? (
                              <polyline
                                key={`fw-${fi}-l-${li}`}
                                points={ringToPoints(line)}
                                fill="none"
                                stroke="rgba(34,197,94,0.7)"
                                strokeWidth={1.5}
                                strokeDasharray="5 4"
                              />
                            ) : null)}
                          </g>
                        );
                      })}
                      {/* Hazard overlays (water=blue, bunker=sand, OB=red, tree_line=green) */}
                      {currentHoleHazards.map((hz, i) => {
                        const pt = geoToPixel(parseFloat(hz.lat), parseFloat(hz.lng));
                        if (!pt) return null;
                        const mpp = centreLat ? metersPerPixel(centreLat, MAP_ZOOM) : 1;
                        const r = Math.max(6, (hz.radiusMeters ?? 10) / mpp);
                        const fill = hz.hazardType === 'water' ? 'rgba(59,130,246,0.35)'
                          : hz.hazardType === 'bunker' ? 'rgba(251,191,36,0.45)'
                          : hz.hazardType === 'ob' ? 'rgba(239,68,68,0.35)'
                          : 'rgba(34,197,94,0.35)';
                        const stroke = hz.hazardType === 'water' ? '#3B82F6'
                          : hz.hazardType === 'bunker' ? '#FBBF24'
                          : hz.hazardType === 'ob' ? '#EF4444'
                          : '#22C55E';
                        return <circle key={i} cx={pt.x} cy={pt.y} r={r} fill={fill} stroke={stroke} strokeWidth={2} />;
                      })}
                      {/* Front green marker */}
                      {frontLat && frontLng && (() => {
                        const pt = geoToPixel(frontLat, frontLng);
                        if (!pt) return null;
                        return (
                          <g>
                            <circle cx={pt.x} cy={pt.y} r={6} fill="none" stroke="#22c55e" strokeWidth={2} />
                            <text x={pt.x + 10} y={pt.y + 4} fill="#22c55e" fontSize="14" fontFamily="sans-serif">F</text>
                          </g>
                        );
                      })()}
                      {/* Back green marker */}
                      {backLat && backLng && (() => {
                        const pt = geoToPixel(backLat, backLng);
                        if (!pt) return null;
                        return (
                          <g>
                            <circle cx={pt.x} cy={pt.y} r={6} fill="none" stroke="#f59e0b" strokeWidth={2} />
                            <text x={pt.x + 10} y={pt.y + 4} fill="#f59e0b" fontSize="14" fontFamily="sans-serif">B</text>
                          </g>
                        );
                      })()}
                      {/* Pin marker (draggable visual) */}
                      <g>
                        <circle cx={pinPixelX()} cy={pinPixelY()} r={10} fill="#C9A84C" opacity={0.9} />
                        <line x1={pinPixelX()} y1={pinPixelY() - 10} x2={pinPixelX()} y2={pinPixelY() - 30} stroke="white" strokeWidth={2} />
                        <text x={pinPixelX()} y={pinPixelY() + 4} textAnchor="middle" fill="white" fontSize="10" fontFamily="sans-serif" fontWeight="bold">P</text>
                      </g>

                      {/* Watch shot trace — connect consecutive shots */}
                      {holeShots.length > 1 && (() => {
                        const pts: string[] = [];
                        for (const s of holeShots) {
                          const ll = shotLatLng(s);
                          const pt = geoToPixel(ll.lat, ll.lng);
                          if (pt) pts.push(`${pt.x},${pt.y}`);
                        }
                        return (
                          <polyline
                            points={pts.join(' ')}
                            fill="none"
                            stroke="#38BDF8"
                            strokeWidth={2}
                            strokeDasharray="4 3"
                            opacity={0.85}
                          />
                        );
                      })()}
                      {/* Snap-target hint (Task #858) — ring at the feature
                          the dragged shot will snap to on release. */}
                      {activeSnap && (() => {
                        const pt = geoToPixel(activeSnap.lat, activeSnap.lng);
                        if (!pt) return null;
                        const colour = activeSnap.kind === 'green' ? '#22c55e'
                          : activeSnap.kind === 'fairway' ? '#84cc16'
                          : '#FBBF24';
                        return (
                          <g>
                            <circle cx={pt.x} cy={pt.y} r={20} fill="none" stroke={colour} strokeWidth={2.5} strokeDasharray="4 3" opacity={0.95} />
                            <circle cx={pt.x} cy={pt.y} r={4} fill={colour} stroke="#000" strokeWidth={1} />
                          </g>
                        );
                      })()}
                      {/* Shot markers, coloured by source (display only — clickable layer below) */}
                      {holeShots.map(s => {
                        const ll = shotLatLng(s);
                        const pt = geoToPixel(ll.lat, ll.lng);
                        if (!pt) return null;
                        const isSelected = s.id === selectedShotId;
                        const style = shotStyle(s.source);
                        return (
                          <g key={s.id}>
                            <circle
                              cx={pt.x}
                              cy={pt.y}
                              r={isSelected ? 14 : 11}
                              fill={style.fill}
                              stroke={isSelected ? '#fff' : style.stroke}
                              strokeWidth={2}
                              opacity={0.95}
                            />
                            <text
                              x={pt.x}
                              y={pt.y + 4}
                              textAnchor="middle"
                              fill="white"
                              fontSize="11"
                              fontFamily="sans-serif"
                              fontWeight="bold"
                            >{s.shotNumber ?? '?'}</text>
                          </g>
                        );
                      })}
                    </svg>
                  )}

                  {/* Clickable + draggable hit-targets for watch shots
                      (separate layer so SVG can stay non-interactive). Tap toggles
                      selection; drag commits a new lat/lng via PATCH (Task #705). */}
                  {imageLoaded && holeShots.map(s => {
                    const ll = shotLatLng(s);
                    const pt = geoToPixel(ll.lat, ll.lng);
                    if (!pt) return null;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        title={`Shot ${s.shotNumber}${s.club ? ` · ${s.club}` : ''} — drag to reposition`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (justDraggedShotRef.current) {
                            justDraggedShotRef.current = false;
                            return;
                          }
                          setSelectedShotId(prev => prev === s.id ? null : s.id);
                        }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          if (s.latitude == null || s.longitude == null) return;
                          shotDragRef.current = {
                            id: s.id,
                            startLat: parseFloat(s.latitude),
                            startLng: parseFloat(s.longitude),
                            startX: e.clientX,
                            startY: e.clientY,
                            moved: false,
                          };
                        }}
                        className="absolute rounded-full bg-transparent border-0 cursor-grab active:cursor-grabbing"
                        style={{
                          left: `${(pt.x / IMG_W) * 100}%`,
                          top: `${(pt.y / IMG_H) * 100}%`,
                          width: 28,
                          height: 28,
                          transform: 'translate(-50%, -50%)',
                        }}
                      />
                    );
                  })}

                  {/* Drag hint */}
                  {imageLoaded && (
                    <div className="absolute bottom-2 left-2 bg-black/60 text-white/70 text-xs px-2 py-1 rounded">
                      {activeSnap ? `Snap → ${activeSnap.label}` : 'Drag to set pin position'}
                    </div>
                  )}
                </div>
              </div>

              {/* Shot source legend / filter — Task #547 */}
              {holeShotsAll.length > 0 && (
                <div className="px-4 py-2 border-t border-white/10 bg-black/20 flex flex-wrap items-center gap-2">
                  <span className="text-xs text-white/40 mr-1">Source:</span>
                  {(['watch','phone','scorer','manual'] as ShotSource[]).map(src => {
                    const count = sourceCounts[src];
                    if (count === 0) return null;
                    const enabled = sourceFilter[src];
                    const style = SHOT_SOURCE_STYLE[src];
                    return (
                      <button
                        key={src}
                        type="button"
                        onClick={() => setSourceFilter(prev => ({ ...prev, [src]: !prev[src] }))}
                        className={`text-xs px-2 py-1 rounded-md border flex items-center gap-1.5 transition-opacity ${
                          enabled ? 'opacity-100' : 'opacity-40'
                        }`}
                        style={{ borderColor: style.stroke, background: `${style.fill}20` }}
                        title={enabled ? `Hide ${style.label} shots` : `Show ${style.label} shots`}
                      >
                        <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: style.fill }} />
                        <span className="text-white/80">{style.label}</span>
                        <span className="text-white/50">{count}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Shot summary + inline editor */}
              {holeShots.length > 0 && (
                <div className="px-4 py-3 border-t border-white/10 bg-sky-500/5">
                  <div className="flex items-center gap-2 mb-2">
                    <Watch className="w-4 h-4 text-sky-400" />
                    <span className="text-sm font-medium text-sky-200">
                      Shots · {holeShots.length}
                    </span>
                    <span className="text-xs text-white/40">tap a shot on the map to edit</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {holeShots.map((s, idx) => {
                      const carry = carryYards(idx);
                      const isSelected = s.id === selectedShotId;
                      const style = shotStyle(s.source);
                      return (
                        <button
                          key={s.id}
                          onClick={() => setSelectedShotId(isSelected ? null : s.id)}
                          className={`text-xs px-2 py-1 rounded-md border transition-colors flex items-center gap-1 ${
                            isSelected
                              ? 'bg-sky-500/30 border-sky-400 text-white'
                              : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10'
                          }`}
                        >
                          <span
                            className="inline-block w-2 h-2 rounded-full"
                            style={{ background: style.fill }}
                            title={style.label}
                          />
                          <span className="font-bold">#{s.shotNumber}</span>
                          {s.club && <span className="ml-1 text-[#C9A84C]">{s.club}</span>}
                          {carry !== null && <span className="ml-1 text-white/50">{carry} yd</span>}
                          {s.shotType && (
                            <span className="ml-1 text-[10px] uppercase text-white/40">{s.shotType}</span>
                          )}
                          <span className="ml-1 text-[10px] uppercase text-white/30">{style.label}</span>
                        </button>
                      );
                    })}
                  </div>

                  {selectedShot && (
                    <div className="mt-3 p-3 rounded-lg bg-[#0a1422] border border-sky-500/30">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-sm font-medium text-white">
                          Edit shot #{selectedShot.shotNumber}
                          <span className="text-xs text-white/40 ml-2">hole {selectedShot.holeNumber}</span>
                        </div>
                        <button
                          onClick={() => setSelectedShotId(null)}
                          className="text-white/40 hover:text-white/80"
                          aria-label="Close shot editor"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-white/40 mb-1">Club</label>
                          <select
                            value={selectedShot.club ?? ''}
                            onChange={(e) => patchShot(selectedShot.id, { club: e.target.value || null })}
                            disabled={shotEditBusy}
                            className="w-full bg-[#111827] border border-white/10 rounded text-white text-xs px-2 py-1.5"
                          >
                            <option value="">—</option>
                            {STANDARD_CLUBS.map(c => (
                              <option key={c} value={c}>{c}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-white/40 mb-1">Lie</label>
                          <select
                            value={selectedShot.lieType ?? ''}
                            onChange={(e) => patchShot(selectedShot.id, { lieType: e.target.value || null })}
                            disabled={shotEditBusy}
                            className="w-full bg-[#111827] border border-white/10 rounded text-white text-xs px-2 py-1.5"
                          >
                            <option value="">—</option>
                            {LIE_TYPES.map(l => (
                              <option key={l} value={l}>{l}</option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="flex gap-2 mt-3">
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs h-7 px-2 border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
                          onClick={() => patchShot(selectedShot.id, { lieType: 'Fairway' })}
                          disabled={shotEditBusy}
                        >
                          Mark Fairway
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-xs h-7 px-2 border-yellow-500/40 text-yellow-300 hover:bg-yellow-500/10"
                          onClick={() => patchShot(selectedShot.id, { lieType: 'Bunker', shotType: 'sand' })}
                          disabled={shotEditBusy}
                        >
                          Mark Sand
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-auto text-xs h-7 px-2 border-red-500/40 text-red-300 hover:bg-red-500/10"
                          onClick={() => deleteShot(selectedShot.id)}
                          disabled={shotEditBusy}
                        >
                          <Trash2 className="w-3 h-3 mr-1" />
                          Delete
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Distance badges & info */}
              <div className="px-4 py-3 flex flex-wrap gap-3 items-center border-t border-white/10">
                {distCentreToFront !== null && (
                  <div className="text-center">
                    <div className="text-xs text-white/40">Front</div>
                    <div className="text-sm font-medium text-green-400">{distCentreToFront} yds</div>
                  </div>
                )}
                {distCentreToBack !== null && (
                  <div className="text-center">
                    <div className="text-xs text-white/40">Back</div>
                    <div className="text-sm font-medium text-amber-400">{distCentreToBack} yds</div>
                  </div>
                )}

                {/* Layup distance badges */}
                <div className="flex gap-1.5 ml-auto">
                  {[100, 150, 200].map(d => (
                    <span key={d} className="px-2 py-0.5 rounded-full bg-white/10 text-white/60 text-xs">{d}</span>
                  ))}
                  <span className="text-xs text-white/20 self-center">yd layups</span>
                </div>
              </div>

              {/* Wind widget + plays-like */}
              {weather && (
                <div className="px-4 py-2 flex items-center gap-4 border-t border-white/10 bg-white/3">
                  <div className="flex items-center gap-2">
                    <Wind className="w-4 h-4 text-blue-400" />
                    <span className="text-sm text-blue-300">{Math.round(weather.windSpeed)} km/h {windDegToLabel(weather.windDirection)}</span>
                    <div
                      className="w-4 h-4 text-blue-400"
                      style={{ transform: `rotate(${weather.windDirection}deg)` }}
                    >▲</div>
                  </div>
                  {playsLike !== null && rawYardage > 0 && playsLikeBd && (
                    <div
                      className="ml-auto flex items-center gap-1"
                      title={[
                        `Raw: ${playsLikeBd.rawYards} yds`,
                        `Plays like: ${playsLikeBd.playsLikeYards} yds`,
                        playsLikeBd.windAdj !== 0 ? `Wind: ${playsLikeBd.windAdj > 0 ? '+' : ''}${playsLikeBd.windAdj} yds` : null,
                        playsLikeBd.elevAdj !== 0 ? `Elevation: ${playsLikeBd.elevAdj > 0 ? '+' : ''}${playsLikeBd.elevAdj} yds` : null,
                      ].filter(Boolean).join('\n')}
                    >
                      <span className="text-xs text-white/40">Plays like</span>
                      <span className="text-sm font-semibold" style={{ color: playsLike > rawYardage ? '#ef4444' : playsLike < rawYardage ? '#22c55e' : '#fff' }}>
                        {playsLike} yds
                      </span>
                      <span className="text-xs text-white/30">(of {rawYardage})</span>
                      {(playsLikeBd.windAdj !== 0 || playsLikeBd.elevAdj !== 0) && (
                        <span className="text-[10px] text-white/40 ml-1">
                          {playsLikeBd.windAdj !== 0 && `${playsLikeBd.windAdj > 0 ? '+' : ''}${playsLikeBd.windAdj} wind`}
                          {playsLikeBd.windAdj !== 0 && playsLikeBd.elevAdj !== 0 && ' / '}
                          {playsLikeBd.elevAdj !== 0 && `${playsLikeBd.elevAdj > 0 ? '+' : ''}${playsLikeBd.elevAdj} elev`}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Pin save controls */}
              <div className="px-4 py-3 flex items-center gap-3 border-t border-white/10">
                <Pin className="w-4 h-4 text-[#C9A84C]" />
                <span className="text-xs text-white/40 flex-1">
                  {hasPinOffset ? 'Custom pin position set' : 'Drag the pin to mark position'}
                </span>
                {hasPinOffset && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-white/40 h-7 px-2"
                    onClick={resetPin}
                  >
                    Reset
                  </Button>
                )}
                <Button
                  size="sm"
                  className="h-7 px-3 text-xs"
                  style={{ background: saved ? '#22c55e20' : '#C9A84C', color: saved ? '#22c55e' : '#000' }}
                  onClick={savePin}
                  disabled={saving}
                >
                  {saved ? 'Saved ✓' : saving ? 'Saving…' : 'Save Pin'}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
