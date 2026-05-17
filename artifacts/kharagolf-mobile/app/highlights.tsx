import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  Image,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { Video, ResizeMode } from "expo-av";
import { File, Paths } from "expo-file-system";
import * as MediaLibrary from "expo-media-library";
import * as Sharing from "expo-sharing";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";

const BASE_URL = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : "";

const API = (path: string) => `${BASE_URL}/api${path}`;

/** Make a relative server URL absolute so React Native players can resolve it. */
const absUrl = (u: string | null | undefined): string => {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  return `${BASE_URL}${u.startsWith("/") ? "" : "/"}${u}`;
};

interface Template {
  id: string;
  name: string;
  description: string;
  durationSeconds: number;
  primaryColor: string;
  secondaryColor: string;
}

interface Reel {
  id: number;
  title: string;
  templateId: string;
  status: "queued" | "rendering" | "ready" | "failed";
  outputUrl: string | null;
  outputObjectPath: string | null;
  feedPostId: number | null;
  durationSeconds: number | null;
  errorMessage: string | null;
  createdAt: string;
  organizationId: number;
  tournamentId: number | null;
  options?: { caption?: string; clips?: Array<{ mediaId: number; caption?: string; startSec?: number; durationSec?: number }> } | null;
  // Render progress (Task #551) — surfaced by the API so players can see
  // where they are in the queue and whether a retry is pending.
  attempts?: number;
  maxAttempts?: number;
  queuePosition?: number | null;
  estimatedWaitSeconds?: number | null;
  isRetrying?: boolean;
  retryInSeconds?: number | null;
  // Task #544 / #708 — engagement counts surfaced by the API. Default to
  // 0 server-side so the chart can render without null-checking.
  downloadCount?: number;
  shareCount?: number;
  viewCount?: number;
  feedShareCount?: number;
  // Task #1011 — best engagement hour (0-23, in viewer's local time) for
  // the trailing 30 days. Null when the reel has no events yet.
  bestHour?: number | null;
}

interface TimeseriesPoint {
  date: string;
  download: number;
  share: number;
  view: number;
  feed_share: number;
}

interface HourlyPoint {
  hour: number;
  download: number;
  share: number;
  view: number;
  feed_share: number;
  total: number;
}

// "7pm" / "12am" — matches the badge copy producers see on the gallery.
function formatHourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return "12am";
  if (h === 12) return "12pm";
  if (h < 12) return `${h}am`;
  return `${h - 12}pm`;
}

// Local-timezone offset in minutes following the JS convention
// `-getTimezoneOffset()`. Captured at module load and sent on every
// list/heatmap fetch so the API can bucket events into the producer's
// local hours.
const LOCAL_TZ_OFFSET_MIN = -new Date().getTimezoneOffset();

// Compact 4-bar chart for the producer-facing highlights gallery
// (Task #863). Renders downloads / shares / views / re-shares side by
// side so producers can see at a glance which engagement type a reel is
// actually pulling — and not just a flat sum.
const ENGAGEMENT_BARS: Array<{ key: "view" | "feed_share" | "share" | "download"; label: string; color: string }> = [
  { key: "view",       label: "Views",     color: "#3b82f6" },
  { key: "feed_share", label: "Re-shares", color: "#a855f7" },
  { key: "share",      label: "Shares",    color: "#22c55e" },
  { key: "download",   label: "Downloads", color: "#f97316" },
];

function EngagementMiniChart({ reel }: { reel: Reel }) {
  const values: Record<string, number> = {
    view: reel.viewCount ?? 0,
    feed_share: reel.feedShareCount ?? 0,
    share: reel.shareCount ?? 0,
    download: reel.downloadCount ?? 0,
  };
  const max = Math.max(1, ...Object.values(values));
  return (
    <View style={chartStyles.row} testID={`engagement-chart-${reel.id}`}>
      {ENGAGEMENT_BARS.map(b => {
        const v = values[b.key];
        const pct = (v / max) * 1.0;
        return (
          <View key={b.key} style={chartStyles.col} testID={`bar-${b.key}-${reel.id}`}>
            <Text style={[chartStyles.value, { color: b.color }]}>{v}</Text>
            <View style={chartStyles.barTrack}>
              <View
                style={{
                  width: "100%",
                  height: `${Math.max(2, pct * 100)}%`,
                  backgroundColor: b.color,
                  opacity: v === 0 ? 0.25 : 1,
                  borderTopLeftRadius: 2,
                  borderTopRightRadius: 2,
                }}
              />
            </View>
            <Text style={chartStyles.label}>{b.label}</Text>
          </View>
        );
      })}
    </View>
  );
}

// Tiny trend chart showing daily Views vs Re-shares for the trend
// window. Built as stacked overlapped bars so we don't need an SVG
// dependency in the mobile bundle.
// 24-cell hour-of-day heatmap (Task #1011). Each cell's blue intensity
// scales with that hour's share of total engagement. The "best hour"
// cell gets a purple outline so it pops against the heat ramp.
function HourHeatmap({ hourly, bestHour }: { hourly: HourlyPoint[]; bestHour: number | null }) {
  const max = Math.max(1, ...hourly.map(h => h.total));
  return (
    <View style={chartStyles.heatmapWrap} testID="hour-heatmap">
      <View style={chartStyles.heatmapRow}>
        {hourly.map(h => {
          const intensity = h.total / max;
          const isBest = bestHour === h.hour;
          return (
            <View
              key={h.hour}
              style={[
                chartStyles.heatmapCell,
                {
                  backgroundColor: `rgba(59, 130, 246, ${0.15 + intensity * 0.85})`,
                  borderColor: isBest ? "#a855f7" : "transparent",
                  borderWidth: isBest ? 1.5 : 1,
                },
              ]}
              testID={`heatmap-hour-${h.hour}`}
            />
          );
        })}
      </View>
      <View style={chartStyles.heatmapAxis}>
        <Text style={chartStyles.heatmapAxisText}>12am</Text>
        <Text style={chartStyles.heatmapAxisText}>6am</Text>
        <Text style={chartStyles.heatmapAxisText}>12pm</Text>
        <Text style={chartStyles.heatmapAxisText}>6pm</Text>
        <Text style={chartStyles.heatmapAxisText}>11pm</Text>
      </View>
    </View>
  );
}

function TrendBars({ series }: { series: TimeseriesPoint[] }) {
  const max = Math.max(1, ...series.map(p => Math.max(p.view, p.feed_share)));
  return (
    <View style={chartStyles.trendRow}>
      {series.map((p, i) => {
        const vh = (p.view / max) * 36;
        const fh = (p.feed_share / max) * 36;
        return (
          <View key={i} style={chartStyles.trendCol}>
            <View style={chartStyles.trendBarTrack}>
              <View style={{ position: "absolute", bottom: 0, left: 0, right: "55%", height: vh, backgroundColor: "#3b82f6", borderTopLeftRadius: 1, borderTopRightRadius: 1 }} />
              <View style={{ position: "absolute", bottom: 0, right: 0, left: "55%", height: fh, backgroundColor: "#a855f7", borderTopLeftRadius: 1, borderTopRightRadius: 1 }} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

const chartStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    height: 64,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    gap: 8,
    marginTop: 10,
  },
  col: { flex: 1, alignItems: "center", justifyContent: "flex-end", height: "100%" },
  barTrack: { width: "100%", height: 32, justifyContent: "flex-end", alignItems: "stretch" },
  value: { fontSize: 10, fontVariant: ["tabular-nums"], marginBottom: 2 },
  label: { fontSize: 9, color: "#888", marginTop: 2 },
  trendRow: { flexDirection: "row", alignItems: "flex-end", height: 40, gap: 2, marginTop: 6 },
  trendCol: { flex: 1, alignItems: "stretch", height: 40 },
  trendBarTrack: { flex: 1, position: "relative" },
  heatmapWrap: { marginTop: 8 },
  heatmapRow: { flexDirection: "row", gap: 2, height: 18 },
  heatmapCell: { flex: 1, borderRadius: 2 },
  heatmapAxis: { flexDirection: "row", justifyContent: "space-between", marginTop: 2 },
  heatmapAxisText: { fontSize: 9, color: "#888" },
});

/** Friendly "about 2 minutes" / "less than a minute" string for an ETA. */
const formatWait = (seconds: number | null | undefined): string => {
  if (seconds == null) return "";
  if (seconds < 45) return "less than a minute";
  const mins = Math.round(seconds / 60);
  if (mins <= 1) return "about a minute";
  if (mins < 60) return `about ${mins} minutes`;
  const hrs = Math.round(mins / 60);
  return hrs === 1 ? "about an hour" : `about ${hrs} hours`;
};

interface Tournament {
  tournamentId: number;
  tournamentName: string;
}

interface Quota {
  monthlyLimit: number;
  usedThisMonth: number;
  remaining: number;
}

interface CaptionSuggestion {
  text: string;
  pattern: string;
  tokenKeys: string[];
  tokens: Record<string, string | number>;
  isFavorite: boolean;
  templateId: number | null;
}

interface CandidateMedia {
  id: number;
  mediaType: "image" | "video" | string;
  caption: string | null;
  holeNumber: number | null;
  thumbnailUrl: string | null;
  url: string | null;
  // True source duration in seconds for video uploads. NULL for images
  // and for legacy video rows uploaded before Task #703 — when unknown
  // we fall back to the existing 30s editor cap.
  durationSeconds?: number | null;
  suggestedCaptions?: string[];
  suggestedCaptionTemplates?: CaptionSuggestion[];
}

interface ClipDraft {
  mediaId: number;
  caption: string;
  // Trim window for video clips. Undefined = use template default
  // (server falls back to the first `perPhotoSeconds` of the source).
  startSec?: number;
  durationSec?: number;
}

// Trim bounds applied in the editor. The server clamps to [0.5, 60] too.
const MIN_CLIP_DURATION = 1;
const MAX_CLIP_DURATION = 30;
const DEFAULT_CLIP_DURATION = 2.5;
const TRIM_STEP = 0.5;
// Width of the draggable timeline handles in pixels. Kept as a constant
// (rather than reading back from StyleSheet) so the handle-centering math
// in the timeline render stays reliable — `StyleSheet.create` returns
// numeric IDs at runtime in some RN versions, so `styles.x.width` cannot
// be relied on.
const TIMELINE_HANDLE_WIDTH = 16;

export default function HighlightsScreen() {
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const [reels, setReels] = useState<Reel[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Task #1012 — Top-performers sort. Producers with many highlights can
  // pivot the gallery to surface the most-engaged reels first instead of
  // the most recent. Sent to the API so the ranking matches the bars on
  // each card.
  type SortMode = "recent" | "top" | "reshared";
  const [sortMode, setSortMode] = useState<SortMode>("recent");

  const [creatorOpen, setCreatorOpen] = useState(false);
  const [editorReel, setEditorReel] = useState<Reel | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [draftTitle, setDraftTitle] = useState("Round Highlights");
  const [draftTemplate, setDraftTemplate] = useState("classic");
  const [draftCaption, setDraftCaption] = useState("");
  const [draftTournamentId, setDraftTournamentId] = useState<number | null>(null);
  const [draftClips, setDraftClips] = useState<ClipDraft[]>([]);
  // Tracks whether the player has explicitly engaged with the clip picker.
  // We only send `options.clips` when this is true so that an unedited reel
  // still gets the server's auto-picked photos (instead of an empty reel).
  const [clipsTouched, setClipsTouched] = useState(false);
  const [candidates, setCandidates] = useState<CandidateMedia[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [previewReel, setPreviewReel] = useState<Reel | null>(null);
  // Task #1961 — when the server clamps a clip's trim window to fit the
  // source video (e.g. user picked start=2s + duration=30s on a 5s clip
  // and the server stored start=2s + duration=3s), surface a one-line
  // notice next to the affected clip so the player isn't confused by
  // the silently shorter reel. Cleared whenever the player edits a clip
  // (so a follow-up tweak doesn't keep the stale notice around) or when
  // the editor closes.
  const [trimClampedMediaIds, setTrimClampedMediaIds] = useState<number[]>([]);
  // Per-clip trim preview (Task #702). Holds the mediaId of the clip being
  // previewed; the actual trim window is read live from `draftClips` so that
  // start/length adjustments take effect on the next play without closing
  // the preview.
  const [previewClipMediaId, setPreviewClipMediaId] = useState<number | null>(null);
  const previewVideoRef = useRef<Video | null>(null);
  // Draggable trim timeline (Task #854). The width of the timeline track is
  // measured at layout time; the start/end handles emit pan deltas in pixels
  // which we convert to seconds using `width / sourceDur`. While the player
  // is actively dragging we render visual feedback via `dragPreview`, but we
  // only commit to `draftClips` (and replay the window) when they release.
  const [timelineWidth, setTimelineWidth] = useState(0);
  const [dragPreview, setDragPreview] = useState<{ startSec: number; durationSec: number } | null>(null);
  // Live playhead position (Task #994). Tracks the currently-playing video
  // position in milliseconds so we can render a vertical line on the trim
  // timeline. Reset to the trim start whenever the window loops/replays
  // and when the preview modal closes.
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);
  // dragRef holds the *committed* trim values (i.e. ignoring `dragPreview`)
  // so PanResponder math stays anchored at the value the user grabbed —
  // updating it from the live drag values would feed back into itself.
  const dragRef = useRef<{
    mediaId: number | null;
    baseStart: number;
    baseDur: number;
    sourceDur: number;
    width: number;
  }>({ mediaId: null, baseStart: 0, baseDur: 0, sourceDur: 0, width: 0 });
  // Latest drag values, written from PanResponder move so release can read
  // them without depending on a re-render landing first.
  const currentDragRef = useRef<{ startSec: number; durationSec: number } | null>(null);
  // When the player taps the timeline track to scrub (Task #995), we seek
  // the preview video to that timestamp and play a short window from there.
  // This ref tells onPlaybackStatusUpdate to pause at the tap window's end
  // instead of the committed trim end, and is cleared once playback reaches
  // it (or the modal closes / a handle drag commits new bounds).
  const tapPreviewEndMsRef = useRef<number | null>(null);

  /** Apply the released drag values to draftClips and replay the window. */
  const commitDragAndReplay = useCallback(() => {
    const drag = currentDragRef.current;
    const mediaId = dragRef.current.mediaId;
    currentDragRef.current = null;
    if (!drag || mediaId == null) {
      setDragPreview(null);
      return;
    }
    const startSec = +drag.startSec.toFixed(2);
    const durationSec = +drag.durationSec.toFixed(2);
    setClipsTouched(true);
    setDraftClips(prev => prev.map(c => c.mediaId === mediaId ? { ...c, startSec, durationSec } : c));
    // Task #1961 — once the player edits the trim window for a clamped
    // clip, the previous "Trimmed to fit" notice no longer reflects what
    // they're about to save, so drop it for that clip.
    setTrimClampedMediaIds(prev => prev.filter(id => id !== mediaId));
    setDragPreview(null);
    // A new trim window supersedes any in-progress tap-scrub.
    tapPreviewEndMsRef.current = null;
    // Wait one tick so the new positionMillis prop lands before we seek.
    // Snap the playhead to the new trim start immediately so it doesn't
    // briefly linger at the previous position before the next status tick
    // (Task #994).
    setPlayheadMs(Math.round(startSec * 1000));
    setTimeout(async () => {
      try {
        await previewVideoRef.current?.setPositionAsync(Math.round(startSec * 1000));
        await previewVideoRef.current?.playAsync();
      } catch { /* video not ready */ }
    }, 50);
  }, []);

  // Stable PanResponder for the START handle: keeps the end fixed and slides
  // the start, recomputing duration so `start + duration === end`.
  const startHandlePan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderMove: (_, g) => {
      const { baseStart, baseDur, sourceDur, width } = dragRef.current;
      if (sourceDur <= 0 || width <= 0) return;
      const baseEnd = baseStart + baseDur;
      const deltaSec = (g.dx / width) * sourceDur;
      const maxStart = Math.max(0, baseEnd - MIN_CLIP_DURATION);
      const newStart = Math.max(0, Math.min(maxStart, baseStart + deltaSec));
      const newDur = Math.max(MIN_CLIP_DURATION, Math.min(MAX_CLIP_DURATION, baseEnd - newStart));
      currentDragRef.current = { startSec: newStart, durationSec: newDur };
      setDragPreview({ startSec: newStart, durationSec: newDur });
    },
    onPanResponderRelease: commitDragAndReplay,
    onPanResponderTerminate: commitDragAndReplay,
  }), [commitDragAndReplay]);

  // Stable PanResponder for the END handle: keeps start fixed and slides
  // the end, recomputing duration so the trim window grows/shrinks from
  // the right.
  const endHandlePan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderMove: (_, g) => {
      const { baseStart, baseDur, sourceDur, width } = dragRef.current;
      if (sourceDur <= 0 || width <= 0) return;
      const deltaSec = (g.dx / width) * sourceDur;
      const maxDur = Math.min(MAX_CLIP_DURATION, Math.max(MIN_CLIP_DURATION, sourceDur - baseStart));
      const newDur = Math.max(MIN_CLIP_DURATION, Math.min(maxDur, baseDur + deltaSec));
      currentDragRef.current = { startSec: baseStart, durationSec: newDur };
      setDragPreview({ startSec: baseStart, durationSec: newDur });
    },
    onPanResponderRelease: commitDragAndReplay,
    onPanResponderTerminate: commitDragAndReplay,
  }), [commitDragAndReplay]);
  // Deep-link target from a "highlight_render_complete" push notification
  // (Task #657). When the user taps the push, _layout.tsx routes here with
  // ?reelId=<id> so we can scroll/open the matching reel as soon as the
  // list loads. We only consume each id once to avoid re-opening the modal
  // every time the screen re-renders.
  const params = useLocalSearchParams<{ reelId?: string }>();
  const focusReelId = params?.reelId ? Number(params.reelId) : null;
  const [consumedFocusReelId, setConsumedFocusReelId] = useState<number | null>(null);

  const editorOpen = creatorOpen || editorReel != null;
  const candidateById = useMemo(() => {
    const m = new Map<number, CandidateMedia>();
    candidates.forEach(c => m.set(c.id, c));
    return m;
  }, [candidates]);

  const loadCandidates = useCallback(async (tournamentId: number | null) => {
    setCandidatesLoading(true);
    try {
      const qs = tournamentId ? `?tournamentId=${tournamentId}` : "";
      const r = await fetch(API(`/portal/highlights/candidate-media${qs}`), { headers: auth });
      if (r.ok) {
        const d = await r.json();
        setCandidates(Array.isArray(d.media) ? d.media : []);
      } else {
        setCandidates([]);
      }
    } catch {
      setCandidates([]);
    } finally {
      setCandidatesLoading(false);
    }
  }, [token]);

  // Refresh candidate media whenever the editor is opened or the
  // tournament selection changes — so thumbnails reflect the current scope.
  useEffect(() => {
    if (!editorOpen) return;
    const tId = editorReel ? editorReel.tournamentId : draftTournamentId;
    loadCandidates(tId ?? null);
  }, [editorOpen, draftTournamentId, editorReel, loadCandidates]);

  const toggleClip = (mediaId: number) => {
    setClipsTouched(true);
    setDraftClips(prev => {
      const idx = prev.findIndex(c => c.mediaId === mediaId);
      if (idx >= 0) return prev.filter((_, i) => i !== idx);
      return [...prev, { mediaId, caption: "" }];
    });
    // Task #1961 — removing or re-adding a clip clears any stale
    // "Trimmed to fit" notice for that mediaId; the next save will
    // re-evaluate and re-flag if the new selection still overruns.
    setTrimClampedMediaIds(prev => prev.filter(id => id !== mediaId));
  };

  const moveClip = (mediaId: number, dir: -1 | 1) => {
    setClipsTouched(true);
    setDraftClips(prev => {
      const idx = prev.findIndex(c => c.mediaId === mediaId);
      if (idx < 0) return prev;
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      return next;
    });
  };

  const setClipCaption = (mediaId: number, caption: string) => {
    setClipsTouched(true);
    setDraftClips(prev => prev.map(c => c.mediaId === mediaId ? { ...c, caption } : c));
  };

  // Task #698 — favorite/unfavorite a caption-style template. We mutate
  // the candidates list optimistically so the star fills instantly, then
  // sync with the server. On error we revert to keep the UI honest.
  const toggleSuggestionFavorite = useCallback(async (mediaId: number, suggestion: CaptionSuggestion) => {
    const wasFavorite = suggestion.isFavorite;
    const newTemplateId = wasFavorite ? null : suggestion.templateId;

    setCandidates(prev => prev.map(c => {
      if (c.id !== mediaId) return c;
      const next = (c.suggestedCaptionTemplates ?? []).map(s =>
        s.pattern === suggestion.pattern
          ? { ...s, isFavorite: !wasFavorite, templateId: newTemplateId }
          : s,
      );
      return { ...c, suggestedCaptionTemplates: next };
    }));

    try {
      if (wasFavorite && suggestion.templateId != null) {
        const r = await fetch(API(`/portal/highlights/caption-templates/${suggestion.templateId}`), {
          method: "DELETE",
          headers: auth,
        });
        if (!r.ok) throw new Error("delete failed");
        setCandidates(prev => prev.map(c => ({
          ...c,
          suggestedCaptionTemplates: (c.suggestedCaptionTemplates ?? []).map(s =>
            s.pattern === suggestion.pattern ? { ...s, isFavorite: false, templateId: null } : s,
          ),
        })));
      } else {
        const r = await fetch(API("/portal/highlights/caption-templates"), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...auth },
          body: JSON.stringify({
            pattern: suggestion.pattern,
            tokenKeys: suggestion.tokenKeys,
            sampleCaption: suggestion.text,
          }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "save failed");
        const tplId = d?.template?.id ?? null;
        setCandidates(prev => prev.map(c => ({
          ...c,
          suggestedCaptionTemplates: (c.suggestedCaptionTemplates ?? []).map(s =>
            s.pattern === suggestion.pattern ? { ...s, isFavorite: true, templateId: tplId } : s,
          ),
        })));
      }
    } catch (e) {
      // Revert on failure.
      setCandidates(prev => prev.map(c => {
        if (c.id !== mediaId) return c;
        const next = (c.suggestedCaptionTemplates ?? []).map(s =>
          s.pattern === suggestion.pattern
            ? { ...s, isFavorite: wasFavorite, templateId: suggestion.templateId }
            : s,
        );
        return { ...c, suggestedCaptionTemplates: next };
      }));
      Alert.alert("Couldn't update favorite", e instanceof Error ? e.message : "Please try again.");
    }
  }, [token]);

  /** Adjust the trim start/duration for a video clip by `delta` seconds.
   *  Each field is set independently so the other can stay undefined and
   *  fall back to the template/server default.
   *
   *  When we know the source video's true duration (Task #703), we keep
   *  `start + length <= duration` so a player can never schedule a clip
   *  that runs past the end of the footage (which would render as black). */
  const adjustClipTrim = (mediaId: number, field: "startSec" | "durationSec", delta: number) => {
    setClipsTouched(true);
    // Task #1961 — see toggleClip / commitDragAndReplay: a fresh trim
    // edit invalidates the prior clamp notice for this clip.
    setTrimClampedMediaIds(prev => prev.filter(id => id !== mediaId));
    setDraftClips(prev => prev.map(c => {
      if (c.mediaId !== mediaId) return c;
      const m = candidateById.get(c.mediaId);
      const sourceDur = typeof m?.durationSeconds === "number" && m.durationSeconds > 0
        ? m.durationSeconds
        : null;
      const curStart = c.startSec ?? 0;
      const curDur = c.durationSec ?? DEFAULT_CLIP_DURATION;
      if (field === "startSec") {
        const tentative = Math.max(0, +(curStart + delta).toFixed(2));
        // Keep `start + length` <= source duration so the clip never
        // runs past the end of the footage. We also guarantee at least
        // MIN_CLIP_DURATION of room remains, which matters for very
        // short videos (e.g. 1.5s source) where curDur > sourceDur.
        const maxStart = sourceDur != null
          ? Math.max(0, +(sourceDur - Math.max(MIN_CLIP_DURATION, Math.min(curDur, sourceDur))).toFixed(2))
          : Infinity;
        return { ...c, startSec: Math.min(tentative, maxStart) };
      }
      const tentativeDur = +(curDur + delta).toFixed(2);
      const maxDur = sourceDur != null
        ? Math.min(MAX_CLIP_DURATION, Math.max(MIN_CLIP_DURATION, +(sourceDur - curStart).toFixed(2)))
        : MAX_CLIP_DURATION;
      const nextDur = Math.min(maxDur, Math.max(MIN_CLIP_DURATION, tentativeDur));
      return { ...c, durationSec: nextDur };
    }));
  };

  /** Whether the given trim stepper button should be disabled because
   *  pressing it would push the trim past the source video's end. Returns
   *  false (always enabled) for legacy clips with unknown duration. */
  const trimStepDisabled = (
    clip: ClipDraft,
    field: "startSec" | "durationSec",
    delta: number,
  ): boolean => {
    const m = candidateById.get(clip.mediaId);
    const sourceDur = typeof m?.durationSeconds === "number" && m.durationSeconds > 0
      ? m.durationSeconds
      : null;
    const curStart = clip.startSec ?? 0;
    const curDur = clip.durationSec ?? DEFAULT_CLIP_DURATION;
    if (field === "startSec") {
      if (delta < 0) return curStart <= 0;
      if (sourceDur == null) return false;
      // Mirror adjustClipTrim's invariant: start + length <= sourceDur,
      // with at least MIN_CLIP_DURATION of room reserved.
      const reserve = Math.max(MIN_CLIP_DURATION, Math.min(curDur, sourceDur));
      const maxStart = Math.max(0, sourceDur - reserve);
      return curStart >= maxStart - 1e-3;
    }
    if (delta < 0) return curDur <= MIN_CLIP_DURATION + 1e-3;
    const cap = sourceDur != null
      ? Math.min(MAX_CLIP_DURATION, Math.max(MIN_CLIP_DURATION, sourceDur - curStart))
      : MAX_CLIP_DURATION;
    return curDur >= cap - 1e-3;
  };

  const fetchAll = useCallback(async () => {
    try {
      const [r1, r2, r3] = await Promise.all([
        fetch(API(`/portal/highlights?sort=${sortMode}&tzOffsetMinutes=${LOCAL_TZ_OFFSET_MIN}`), { headers: auth }),
        fetch(API("/portal/highlights/templates"), { headers: auth }),
        fetch(API("/portal/my-tournaments"), { headers: auth }),
      ]);
      if (r1.ok) {
        const d = await r1.json();
        setReels(d.reels ?? []);
        setQuota(d.quota ?? null);
      }
      if (r2.ok) {
        const d = await r2.json();
        setTemplates(d.templates ?? []);
      }
      if (r3.ok) {
        const raw: unknown = await r3.json();
        const list: unknown[] = Array.isArray(raw)
          ? raw
          : Array.isArray((raw as { tournaments?: unknown[] })?.tournaments)
            ? (raw as { tournaments: unknown[] }).tournaments
            : [];
        const parsed: Tournament[] = [];
        for (const item of list) {
          if (!item || typeof item !== "object") continue;
          const o = item as Record<string, unknown>;
          const idVal = typeof o.tournamentId === "number"
            ? o.tournamentId
            : typeof o.id === "number" ? o.id : null;
          if (idVal == null) continue;
          const nameVal = typeof o.tournamentName === "string"
            ? o.tournamentName
            : typeof o.name === "string" ? o.name : `Tournament #${idVal}`;
          parsed.push({ tournamentId: idVal, tournamentName: nameVal });
        }
        setTournaments(parsed);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token, sortMode]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // When a "your highlight is ready" push deep-links us here, find the
  // matching reel and open it. For ready reels we pop the fullscreen
  // preview; for failed reels we just leave the list open (the row already
  // shows the failure + retry controls). Each id is consumed once so the
  // modal doesn't re-open on every re-render.
  useEffect(() => {
    if (focusReelId == null || consumedFocusReelId === focusReelId) return;
    if (reels.length === 0) return;
    const target = reels.find(r => r.id === focusReelId);
    if (!target) return;
    setConsumedFocusReelId(focusReelId);
    if (target.status === "ready" && target.outputUrl) {
      setPreviewReel(target);
    }
  }, [reels, focusReelId, consumedFocusReelId]);

  // Poll while any reel is queued/rendering. Use a tighter 2s cadence so the
  // queue position and retry countdown feel live to a waiting player.
  useEffect(() => {
    const pending = reels.some(r => r.status === "queued" || r.status === "rendering");
    if (!pending) return;
    const t = setInterval(() => fetchAll(), 2000);
    return () => clearInterval(t);
  }, [reels, fetchAll]);

  const onRefresh = () => { setRefreshing(true); fetchAll(); };

  // Build the options payload. We only include `clips` when the player has
  // explicitly engaged with the clip picker — otherwise the server keeps
  // its existing auto-pick behavior (don't strand users with an empty reel).
  const buildOptions = () => {
    const opts: { caption: string; clips?: { mediaId: number; caption?: string; startSec?: number; durationSec?: number }[] } = {
      caption: draftCaption,
    };
    if (clipsTouched) {
      opts.clips = draftClips.slice(0, 12).map(c => {
        const m = candidateById.get(c.mediaId);
        // Trim only applies to videos, but if candidate metadata isn't loaded
        // yet we still pass through any saved trim values rather than dropping
        // them. The server clamps + ignores them for non-video media.
        const isPhoto = m?.mediaType === "image";
        return {
          mediaId: c.mediaId,
          caption: c.caption.trim() || undefined,
          startSec: !isPhoto && typeof c.startSec === "number" ? c.startSec : undefined,
          durationSec: !isPhoto && typeof c.durationSec === "number" ? c.durationSec : undefined,
        };
      });
    }
    return opts;
  };

  const createReel = async () => {
    setSubmitting(true);
    try {
      const r = await fetch(API("/portal/highlights"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({
          title: draftTitle.trim() || "Round Highlights",
          templateId: draftTemplate,
          tournamentId: draftTournamentId,
          options: buildOptions(),
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        // Task #469 — surface a deep link to the consent centre when the
        // member has withdrawn video or AI consent.
        if (r.status === 403 && d.code === "CONSENT_REQUIRED") {
          Alert.alert(
            "Consent required",
            d.consentRequired?.message || "Highlight reels need video and AI consent to render.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Open Consent Settings", onPress: () => router.push("/my-360/consents") },
            ],
          );
        } else {
          Alert.alert("Cannot create reel", d.error || "Please try again");
        }
      } else {
        // Task #1961 — if the server clamped any clip's trim window to
        // fit the source video, keep the editor open so the player can
        // see the in-place "Trimmed to fit the source video" notice
        // next to the affected clip(s) instead of being whisked back
        // to the gallery while their pick was silently shortened. We
        // also overwrite the local startSec/durationSec with the
        // persisted (clamped) values so the trim controls show what
        // actually got saved.
        const clamped: number[] = Array.isArray(d?.trimClampedMediaIds)
          ? d.trimClampedMediaIds.map((n: unknown) => Number(n)).filter(Number.isFinite)
          : [];
        const persistedClips: Array<{ mediaId: number; startSec?: number; durationSec?: number }>
          = Array.isArray(d?.options?.clips) ? d.options.clips : [];
        if (clamped.length > 0) {
          const persistedById = new Map(persistedClips.map(p => [Number(p.mediaId), p]));
          setDraftClips(prev => prev.map(c => {
            const p = persistedById.get(c.mediaId);
            if (!p) return c;
            return {
              ...c,
              startSec: typeof p.startSec === "number" ? p.startSec : c.startSec,
              durationSec: typeof p.durationSec === "number" ? p.durationSec : c.durationSec,
            };
          }));
          setTrimClampedMediaIds(clamped);
          await fetchAll();
        } else {
          setCreatorOpen(false);
          setDraftCaption("");
          setDraftTitle("Round Highlights");
          setDraftTemplate("classic");
          setDraftTournamentId(null);
          setDraftClips([]);
          setClipsTouched(false);
          setTrimClampedMediaIds([]);
          await fetchAll();
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  const reRender = async (reel: Reel) => {
    setSubmitting(true);
    try {
      const r = await fetch(API(`/portal/highlights/${reel.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({
          title: draftTitle.trim() || reel.title,
          templateId: draftTemplate,
          options: buildOptions(),
        }),
      });
      const d = await r.json();
      if (!r.ok) Alert.alert("Cannot re-render", d.error || "Please try again");
      else {
        // Task #1961 — same trim-clamp surfacing as createReel: keep
        // the editor open with the in-place notice when the server
        // shortened any clip's window to fit the source video. The
        // re-render still kicked off (the row is queued) — the modal
        // just sticks around so the player can see what happened.
        const clamped: number[] = Array.isArray(d?.trimClampedMediaIds)
          ? d.trimClampedMediaIds.map((n: unknown) => Number(n)).filter(Number.isFinite)
          : [];
        const persistedClips: Array<{ mediaId: number; startSec?: number; durationSec?: number }>
          = Array.isArray(d?.options?.clips) ? d.options.clips : [];
        if (clamped.length > 0) {
          const persistedById = new Map(persistedClips.map(p => [Number(p.mediaId), p]));
          setDraftClips(prev => prev.map(c => {
            const p = persistedById.get(c.mediaId);
            if (!p) return c;
            return {
              ...c,
              startSec: typeof p.startSec === "number" ? p.startSec : c.startSec,
              durationSec: typeof p.durationSec === "number" ? p.durationSec : c.durationSec,
            };
          }));
          setTrimClampedMediaIds(clamped);
          await fetchAll();
        } else {
          setEditorReel(null);
          setDraftClips([]);
          setClipsTouched(false);
          setTrimClampedMediaIds([]);
          await fetchAll();
        }
      }
    } finally { setSubmitting(false); }
  };

  const deleteReel = (reel: Reel) => {
    Alert.alert("Delete reel?", reel.title, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
        await fetch(API(`/portal/highlights/${reel.id}`), { method: "DELETE", headers: auth });
        fetchAll();
      } },
    ]);
  };

  const [busyReelId, setBusyReelId] = useState<number | null>(null);

  // Task #863 — per-reel engagement trend (lazy-loaded, cached). The
  // window is shared across rows so picking 30d on one reel widens them all.
  const [trendOpen, setTrendOpen] = useState<Record<number, boolean>>({});
  // Cache key includes the days window so a 7d row stays cached even after
  // the producer toggles the global window to 30d on a different reel.
  const [trendData, setTrendData] = useState<Record<string, TimeseriesPoint[]>>({});
  const [trendLoading, setTrendLoading] = useState<Record<number, boolean>>({});
  const [trendDays, setTrendDays] = useState<7 | 30>(7);
  const trendKey = (reelId: number, days: number) => `${reelId}:${days}`;
  // Task #1011 — hour-of-day heatmap data, lazy-loaded the first time a
  // trend panel is opened. Cached per (reelId, days) so re-toggles are
  // instant; the per-card "Best hour" badge uses the bestHour field
  // already returned on the list payload.
  const [hourlyData, setHourlyData] = useState<Record<string, { hourly: HourlyPoint[]; bestHour: number | null }>>({});

  const loadTrend = useCallback(async (reelId: number, days: number) => {
    setTrendLoading(prev => ({ ...prev, [reelId]: true }));
    try {
      const [tr, hr] = await Promise.all([
        fetch(API(`/portal/highlights/${reelId}/engagement-timeseries?days=${days}`), { headers: auth }),
        fetch(API(`/portal/highlights/${reelId}/engagement-hourly?days=${days}&tzOffsetMinutes=${LOCAL_TZ_OFFSET_MIN}`), { headers: auth }),
      ]);
      if (tr.ok) {
        const d = await tr.json();
        setTrendData(prev => ({ ...prev, [trendKey(reelId, days)]: Array.isArray(d?.series) ? d.series : [] }));
      }
      if (hr.ok) {
        const d = await hr.json();
        setHourlyData(prev => ({
          ...prev,
          [trendKey(reelId, days)]: {
            hourly: Array.isArray(d?.hourly) ? d.hourly : [],
            bestHour: typeof d?.bestHour === "number" ? d.bestHour : null,
          },
        }));
      }
    } finally {
      setTrendLoading(prev => ({ ...prev, [reelId]: false }));
    }
  }, [token]);

  const toggleTrend = (reelId: number) => {
    const willOpen = !trendOpen[reelId];
    setTrendOpen(prev => ({ ...prev, [reelId]: willOpen }));
    if (willOpen && !trendData[trendKey(reelId, trendDays)]) loadTrend(reelId, trendDays);
  };

  // Refresh open trends when the player toggles between 7d and 30d.
  useEffect(() => {
    Object.entries(trendOpen).forEach(([id, open]) => {
      const reelId = Number(id);
      if (open && !trendData[trendKey(reelId, trendDays)]) loadTrend(reelId, trendDays);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trendDays]);

  // Task #544 — fire-and-forget engagement ping. We swallow errors so that
  // a flaky network never blocks the actual download/share UX.
  const logEngagement = (reel: Reel, type: "download" | "share") => {
    try {
      fetch(API(`/portal/highlights/${reel.id}/events`), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ type, source: "mobile" }),
      }).catch(() => { /* best-effort analytics */ });
    } catch {
      /* best-effort analytics */
    }
  };

  const downloadReelFile = async (reel: Reel): Promise<string | null> => {
    if (!reel.outputUrl) return null;
    const remote = absUrl(reel.outputUrl);
    const safeName = reel.title.replace(/[^a-z0-9]+/gi, "_").slice(0, 40) || "highlight";
    const fileName = `${safeName}_${reel.id}.mp4`;
    const target = new File(Paths.cache, fileName);
    if (target.exists) {
      try { target.delete(); } catch { /* ignore */ }
    }
    const downloaded = await File.downloadFileAsync(remote, target);
    return downloaded.uri;
  };

  const saveToGallery = async (reel: Reel) => {
    if (!reel.outputUrl) return;
    setBusyReelId(reel.id);
    try {
      const perm = await MediaLibrary.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Permission needed",
          "We need access to your photo library to save the reel.",
        );
        return;
      }
      const localUri = await downloadReelFile(reel);
      if (!localUri) return;
      await MediaLibrary.saveToLibraryAsync(localUri);
      logEngagement(reel, "download");
      Alert.alert("Saved", "Highlight reel saved to your gallery.");
    } catch (e) {
      Alert.alert("Download failed", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusyReelId(null);
    }
  };

  const shareReel = async (reel: Reel) => {
    if (!reel.outputUrl) return;
    setBusyReelId(reel.id);
    try {
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        Alert.alert("Sharing unavailable", "Sharing is not supported on this device.");
        return;
      }
      const localUri = await downloadReelFile(reel);
      if (!localUri) return;
      await Sharing.shareAsync(localUri, {
        mimeType: "video/mp4",
        dialogTitle: reel.title,
        UTI: "public.mpeg-4",
      });
      logEngagement(reel, "share");
    } catch (e) {
      Alert.alert("Share failed", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusyReelId(null);
    }
  };

  const postToFeed = async (reel: Reel) => {
    const r = await fetch(API(`/portal/highlights/${reel.id}/post-to-feed`), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ body: draftCaption || reel.title, privacy: "all_members" }),
    });
    const d = await r.json();
    if (!r.ok) Alert.alert("Cannot post", d.error || "Please try again");
    else {
      Alert.alert("Posted", "Your highlight reel is now in the feed.");
      setEditorReel(null);
      setPreviewReel(null);
      fetchAll();
    }
  };

  const statusColor = (s: Reel["status"]) =>
    s === "ready" ? "#4ade80" : s === "failed" ? "#f87171" : Colors.tabIconDefault;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn}>
          <Feather name="arrow-left" size={22} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Highlight Reels</Text>
        <TouchableOpacity
          onPress={() => router.push("/highlight-caption-styles" as never)}
          style={styles.iconBtn}
          accessibilityLabel="Manage caption styles"
        >
          <Feather name="bookmark" size={20} color={Colors.primary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setCreatorOpen(true)} style={styles.iconBtn}>
          <Feather name="plus" size={22} color={Colors.primary} />
        </TouchableOpacity>
      </View>

      {quota && (
        <View style={styles.quotaBar}>
          <Text style={styles.quotaText}>
            {quota.monthlyLimit >= 9999
              ? `${quota.usedThisMonth} renders this month · Unlimited`
              : `${quota.usedThisMonth} of ${quota.monthlyLimit} renders used this month`}
          </Text>
        </View>
      )}

      {/* Task #1012 — sort chips above the list. Hidden until we have at
          least two reels — sorting one item is meaningless. */}
      {!loading && reels.length > 1 && (
        <View style={styles.sortBar} testID="highlights-sort-bar">
          <Text style={styles.sortLabel}>Sort:</Text>
          {([
            { id: "recent",   label: "Newest" },
            { id: "top",      label: "Top performing" },
            { id: "reshared", label: "Most re-shared" },
          ] as Array<{ id: SortMode; label: string }>).map(opt => (
            <TouchableOpacity
              key={opt.id}
              onPress={() => setSortMode(opt.id)}
              style={[styles.sortChip, sortMode === opt.id && styles.sortChipActive]}
              testID={`btn-sort-${opt.id}`}
            >
              <Text style={[styles.sortChipText, sortMode === opt.id && styles.sortChipTextActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {loading ? (
        <LoadingSpinner color={Colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={reels}
          keyExtractor={r => String(r.id)}
          contentContainerStyle={{ padding: 16, paddingBottom: 80 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fff" />}
          ListEmptyComponent={
            <View style={{ alignItems: "center", marginTop: 60 }}>
              <Feather name="video" size={48} color={Colors.tabIconDefault} />
              <Text style={{ color: "#fff", fontSize: 16, fontWeight: "600", marginTop: 12 }}>No reels yet</Text>
              <Text style={{ color: Colors.tabIconDefault, fontSize: 13, marginTop: 4, textAlign: "center", paddingHorizontal: 30 }}>
                Generate a highlight video from your latest round.
              </Text>
              <TouchableOpacity style={styles.primaryBtn} onPress={() => setCreatorOpen(true)}>
                <Text style={styles.primaryBtnText}>Create your first reel</Text>
              </TouchableOpacity>
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>{item.title}</Text>
                  <Text style={styles.cardMeta}>
                    {item.templateId} · {new Date(item.createdAt).toLocaleDateString()}
                    {item.durationSeconds ? ` · ${item.durationSeconds}s` : ""}
                  </Text>
                </View>
                {/* Task #871 — quick download/share count badges so mobile
                    producers see the same engagement signal as the web admin
                    dashboard (Task #707) without having to open the chart. */}
                <View
                  style={styles.engagementBadge}
                  testID={`badge-download-${item.id}`}
                >
                  <Feather name="download" size={11} color="#f97316" />
                  <Text style={styles.engagementBadgeText}>{item.downloadCount ?? 0}</Text>
                </View>
                <View
                  style={styles.engagementBadge}
                  testID={`badge-share-${item.id}`}
                >
                  <Feather name="share-2" size={11} color="#22c55e" />
                  <Text style={styles.engagementBadgeText}>{item.shareCount ?? 0}</Text>
                </View>
                <View style={[styles.statusPill, { borderColor: statusColor(item.status) }]}>
                  <Text style={[styles.statusText, { color: statusColor(item.status) }]}>
                    {item.status}
                  </Text>
                </View>
              </View>

              {item.status === "ready" && item.outputUrl && (
                <Pressable onPress={() => setPreviewReel(item)}>
                  <Video
                    source={{ uri: absUrl(item.outputUrl) }}
                    style={styles.video}
                    useNativeControls
                    resizeMode={ResizeMode.COVER}
                  />
                </Pressable>
              )}

              {item.status === "rendering" || item.status === "queued" ? (
                <View style={styles.renderingBox}>
                  <LoadingSpinner color={Colors.primary} />
                  <View style={{ flex: 1, marginLeft: 10 }}>
                    <Text style={styles.progressTitle}>
                      {item.status === "rendering"
                        ? "Rendering your highlights…"
                        : item.isRetrying
                          ? "Retrying after a hiccup…"
                          : item.queuePosition && item.queuePosition > 1
                            ? `Queued · #${item.queuePosition} in line`
                            : "Queued · you're up next"}
                    </Text>
                    {item.status === "queued" && item.isRetrying && item.retryInSeconds != null && (
                      <Text style={styles.progressMeta}>
                        Last attempt failed — retrying in {item.retryInSeconds < 60
                          ? `${item.retryInSeconds}s`
                          : `${Math.ceil(item.retryInSeconds / 60)}m`}
                        {item.attempts && item.maxAttempts
                          ? ` · attempt ${item.attempts + 1} of ${item.maxAttempts}`
                          : ""}
                      </Text>
                    )}
                    {item.status === "queued" && !item.isRetrying && item.estimatedWaitSeconds != null && (
                      <Text style={styles.progressMeta}>
                        Estimated wait: {formatWait(item.estimatedWaitSeconds)}
                      </Text>
                    )}
                    {item.status === "rendering" && (
                      <Text style={styles.progressMeta}>
                        This usually takes about a minute.
                        {item.attempts && item.attempts > 1 ? ` (Attempt ${item.attempts} of ${item.maxAttempts ?? 4})` : ""}
                      </Text>
                    )}
                  </View>
                </View>
              ) : null}

              {item.status === "failed" && (
                <Text style={{ color: "#f87171", fontSize: 12, marginTop: 4 }}>
                  {item.errorMessage || "Render failed"}
                  {item.attempts && item.maxAttempts
                    ? ` · gave up after ${item.attempts} of ${item.maxAttempts} attempts`
                    : ""}
                </Text>
              )}

              {/* Task #1011 — best-hour badge so producers see at a glance
                  when their audience is most active. */}
              {item.bestHour != null && (
                <View style={styles.bestHourBadge} testID={`best-hour-${item.id}`}>
                  <Feather name="clock" size={11} color={Colors.primary} />
                  <Text style={styles.bestHourText}>Best hour: {formatHourLabel(item.bestHour)}</Text>
                </View>
              )}

              {/* Task #863 — engagement breakdown chart + trend toggle. */}
              <EngagementMiniChart reel={item} />
              <View style={{ flexDirection: "row", marginTop: 6, alignItems: "center" }}>
                <TouchableOpacity
                  style={styles.trendToggleBtn}
                  onPress={() => toggleTrend(item.id)}
                  testID={`btn-trend-${item.id}`}
                >
                  <Feather name="bar-chart-2" size={12} color={Colors.primary} />
                  <Text style={styles.trendToggleText}>
                    {trendOpen[item.id] ? "Hide trend" : "Trend"}
                  </Text>
                </TouchableOpacity>
                {trendOpen[item.id] && (
                  <View style={{ flexDirection: "row", marginLeft: 8, gap: 4 }}>
                    {([7, 30] as const).map(d => (
                      <TouchableOpacity
                        key={d}
                        onPress={() => setTrendDays(d)}
                        style={[styles.trendDayChip, trendDays === d && styles.trendDayChipActive]}
                        testID={`btn-trend-${item.id}-${d}d`}
                      >
                        <Text style={[styles.trendDayChipText, trendDays === d && styles.trendDayChipTextActive]}>
                          {d}d
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
              {trendOpen[item.id] && (
                <View style={styles.trendPanel} testID={`trend-panel-${item.id}`}>
                  <View style={styles.trendLegend}>
                    <View style={styles.trendLegendItem}>
                      <View style={[styles.trendLegendDot, { backgroundColor: "#3b82f6" }]} />
                      <Text style={styles.trendLegendText}>Views</Text>
                    </View>
                    <View style={styles.trendLegendItem}>
                      <View style={[styles.trendLegendDot, { backgroundColor: "#a855f7" }]} />
                      <Text style={styles.trendLegendText}>Re-shares</Text>
                    </View>
                    <Text style={[styles.trendLegendText, { marginLeft: "auto" }]}>Last {trendDays} days</Text>
                  </View>
                  {trendLoading[item.id] ? (
                    <LoadingSpinner color={Colors.primary} style={{ marginVertical: 12 }} />
                  ) : trendData[trendKey(item.id, trendDays)] && trendData[trendKey(item.id, trendDays)].length > 0 ? (
                    <TrendBars series={trendData[trendKey(item.id, trendDays)]} />
                  ) : (
                    <Text style={styles.trendEmpty}>No engagement events in this window yet.</Text>
                  )}
                  {/* Task #1011 — hour-of-day heatmap, alongside the daily
                      sparkline so producers see both "which days" and
                      "which hours" their reel pulls traction. */}
                  {hourlyData[trendKey(item.id, trendDays)] && (
                    <View style={styles.hourPanel}>
                      <Text style={styles.hourPanelLabel}>
                        Hour of day
                        {hourlyData[trendKey(item.id, trendDays)].bestHour != null && (
                          <Text style={styles.hourPanelPeak}>
                            {"  ·  Peak "}
                            {formatHourLabel(hourlyData[trendKey(item.id, trendDays)].bestHour!)}
                          </Text>
                        )}
                      </Text>
                      <HourHeatmap
                        hourly={hourlyData[trendKey(item.id, trendDays)].hourly}
                        bestHour={hourlyData[trendKey(item.id, trendDays)].bestHour}
                      />
                    </View>
                  )}
                </View>
              )}

              <View style={{ flexDirection: "row", marginTop: 10, gap: 8 }}>
                {item.status === "ready" && !item.feedPostId && (
                  <TouchableOpacity style={styles.actionBtn} onPress={() => {
                    setDraftCaption(item.title);
                    postToFeed(item);
                  }}>
                    <Feather name="send" size={14} color="#fff" />
                    <Text style={styles.actionText}>Post to feed</Text>
                  </TouchableOpacity>
                )}
                {item.feedPostId && (
                  <View style={[styles.actionBtn, { backgroundColor: "#1a3a1a" }]}>
                    <Feather name="check" size={14} color="#4ade80" />
                    <Text style={[styles.actionText, { color: "#4ade80" }]}>Posted</Text>
                  </View>
                )}
                {item.status === "ready" && item.outputUrl && (
                  <TouchableOpacity style={styles.actionBtn} onPress={() => setPreviewReel(item)}>
                    <Feather name="play" size={14} color="#fff" />
                    <Text style={styles.actionText}>Preview</Text>
                  </TouchableOpacity>
                )}
                {item.status === "ready" && item.outputUrl && Platform.OS !== "web" && (
                  <TouchableOpacity
                    style={styles.actionBtn}
                    disabled={busyReelId === item.id}
                    onPress={() => saveToGallery(item)}
                  >
                    {busyReelId === item.id ? (
                      <LoadingSpinner size="small" color="#fff" />
                    ) : (
                      <Feather name="download" size={14} color="#fff" />
                    )}
                    <Text style={styles.actionText}>Download</Text>
                  </TouchableOpacity>
                )}
                {item.status === "ready" && item.outputUrl && Platform.OS !== "web" && (
                  <TouchableOpacity
                    style={styles.actionBtn}
                    disabled={busyReelId === item.id}
                    onPress={() => shareReel(item)}
                  >
                    {busyReelId === item.id ? (
                      <LoadingSpinner size="small" color="#fff" />
                    ) : (
                      <Feather name="share-2" size={14} color="#fff" />
                    )}
                    <Text style={styles.actionText}>Share</Text>
                  </TouchableOpacity>
                )}
                {!item.feedPostId && item.status !== "rendering" && (
                  <TouchableOpacity style={styles.actionBtn} onPress={() => {
                    setDraftTitle(item.title);
                    setDraftTemplate(item.templateId);
                    setDraftCaption(item.options?.caption ?? "");
                    const hadClips = Array.isArray(item.options?.clips);
                    const seeded = hadClips
                      ? item.options!.clips!.map(c => ({
                          mediaId: Number(c.mediaId),
                          caption: c.caption ?? "",
                          startSec: typeof c.startSec === "number" ? c.startSec : undefined,
                          durationSec: typeof c.durationSec === "number" ? c.durationSec : undefined,
                        }))
                      : [];
                    setDraftClips(seeded);
                    // If the reel was already rendered with an explicit clip list,
                    // preserve that contract on re-render (don't fall back to autopick).
                    setClipsTouched(hadClips);
                    setEditorReel(item);
                  }}>
                    <Feather name="edit-2" size={14} color="#fff" />
                    <Text style={styles.actionText}>Edit & re-render</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={[styles.actionBtn, { backgroundColor: "#3a1a1a" }]} onPress={() => deleteReel(item)}>
                  <Feather name="trash-2" size={14} color="#f87171" />
                </TouchableOpacity>
              </View>
            </View>
          )}
        />
      )}

      {/* Creator / Editor Modal */}
      <Modal
        visible={creatorOpen || editorReel != null}
        animationType="slide"
        transparent
        onRequestClose={() => { setCreatorOpen(false); setEditorReel(null); setTrimClampedMediaIds([]); }}
      >
        <View style={styles.modalRoot}>
          <View style={styles.sheet}>
            <ScrollView showsVerticalScrollIndicator={false}>
              <Text style={styles.sheetTitle}>
                {editorReel ? "Edit & re-render" : "New highlight reel"}
              </Text>

              <Text style={styles.label}>Title</Text>
              <TextInput
                value={draftTitle}
                onChangeText={setDraftTitle}
                placeholder="Round Highlights"
                placeholderTextColor={Colors.tabIconDefault}
                style={styles.input}
              />

              <Text style={styles.label}>Caption (optional)</Text>
              <TextInput
                value={draftCaption}
                onChangeText={setDraftCaption}
                placeholder="Tell the club about your round…"
                placeholderTextColor={Colors.tabIconDefault}
                style={[styles.input, { height: 70 }]}
                multiline
              />

              {!editorReel && tournaments.length > 0 && (
                <>
                  <Text style={styles.label}>Tournament (optional)</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
                    <TouchableOpacity
                      onPress={() => setDraftTournamentId(null)}
                      style={[styles.chip, draftTournamentId == null && styles.chipActive]}
                    >
                      <Text style={[styles.chipText, draftTournamentId == null && styles.chipTextActive]}>None</Text>
                    </TouchableOpacity>
                    {tournaments.slice(0, 8).map(t => (
                      <TouchableOpacity
                        key={t.tournamentId}
                        onPress={() => setDraftTournamentId(t.tournamentId)}
                        style={[styles.chip, draftTournamentId === t.tournamentId && styles.chipActive]}
                      >
                        <Text style={[styles.chipText, draftTournamentId === t.tournamentId && styles.chipTextActive]} numberOfLines={1}>
                          {t.tournamentName}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </>
              )}

              <Text style={styles.label}>Clips & photos</Text>
              <Text style={styles.helpText}>
                Pick which photos and shot videos appear in your reel and add a caption to each. Drag the arrows to reorder.
              </Text>

              {draftClips.length > 0 && (
                <View style={{ marginTop: 6, marginBottom: 8 }}>
                  {draftClips.map((c, i) => {
                    const m = candidateById.get(c.mediaId);
                    return (
                      <View key={c.mediaId} style={styles.clipRow}>
                        <View style={styles.clipIndex}>
                          <Text style={styles.clipIndexText}>{i + 1}</Text>
                        </View>
                        <Pressable
                          onPress={() => {
                            if (m?.mediaType === "video" && m?.url) setPreviewClipMediaId(c.mediaId);
                          }}
                          style={{ position: "relative" }}
                        >
                          {m?.thumbnailUrl ? (
                            <Image source={{ uri: absUrl(m.thumbnailUrl) }} style={styles.clipThumb} />
                          ) : (
                            <View style={[styles.clipThumb, { alignItems: "center", justifyContent: "center" }]}>
                              <Feather name={m?.mediaType === "video" ? "video" : "image"} size={20} color={Colors.tabIconDefault} />
                            </View>
                          )}
                          {m?.mediaType === "video" && m?.url && (
                            <View style={styles.clipThumbPlay}>
                              <Feather name="play" size={14} color="#fff" />
                            </View>
                          )}
                        </Pressable>
                        <View style={{ flex: 1 }}>
                          <TextInput
                            value={c.caption}
                            onChangeText={(t) => setClipCaption(c.mediaId, t)}
                            placeholder="Caption (optional)"
                            placeholderTextColor={Colors.tabIconDefault}
                            style={styles.clipCaptionInput}
                            maxLength={140}
                          />
                          {(() => {
                            const rich = m?.suggestedCaptionTemplates ?? [];
                            const fallback = (m?.suggestedCaptions ?? []).map(t => ({
                              text: t, pattern: t, tokenKeys: [], tokens: {}, isFavorite: false, templateId: null,
                            } as CaptionSuggestion));
                            const list = rich.length > 0 ? rich : fallback;
                            if (list.length === 0) return null;
                            return (
                              <View style={styles.suggestionRow}>
                                {list.map((s, si) => {
                                  // Only allow favoriting suggestions whose pattern is template-like
                                  // (i.e. came from the server with token keys). Plain-text fallbacks
                                  // can still be tapped to fill the caption.
                                  const canFavorite = s.tokenKeys.length > 0;
                                  return (
                                    <View key={si} style={[styles.suggestionChip, s.isFavorite && styles.suggestionChipFav]}>
                                      <TouchableOpacity
                                        onPress={() => {
                                          setClipCaption(c.mediaId, s.text);
                                          // Task #856 — track usage so the management
                                          // screen can rank styles by how often a player
                                          // actually applies them. Best-effort only.
                                          if (s.templateId != null) {
                                            fetch(API(`/portal/highlights/caption-templates/${s.templateId}/use`), {
                                              method: "POST",
                                              headers: { "Content-Type": "application/json", ...auth },
                                              body: JSON.stringify({ sampleCaption: s.text }),
                                            }).catch(() => { /* analytics best-effort */ });
                                          }
                                        }}
                                        style={styles.suggestionChipMain}
                                      >
                                        <Feather name="zap" size={10} color={s.isFavorite ? "#facc15" : Colors.primary} />
                                        <Text style={styles.suggestionChipText} numberOfLines={1}>{s.text}</Text>
                                      </TouchableOpacity>
                                      {canFavorite && (
                                        <TouchableOpacity
                                          onPress={() => toggleSuggestionFavorite(c.mediaId, s)}
                                          style={styles.suggestionStarBtn}
                                          hitSlop={8}
                                          accessibilityLabel={s.isFavorite ? "Unfavorite caption style" : "Favorite caption style"}
                                        >
                                          <Feather
                                            name="star"
                                            size={12}
                                            color={s.isFavorite ? "#facc15" : Colors.tabIconDefault}
                                          />
                                        </TouchableOpacity>
                                      )}
                                    </View>
                                  );
                                })}
                              </View>
                            );
                          })()}
                          <Text style={styles.clipMeta}>
                            {m?.mediaType === "video" ? "Video" : "Photo"}
                            {m?.holeNumber ? ` · Hole ${m.holeNumber}` : ""}
                          </Text>
                          {m?.mediaType === "video" && (typeof m.durationSeconds !== "number" || m.durationSeconds <= 0) && (
                            <View style={styles.trimUnverifiable} testID={`trim-unverifiable-${c.mediaId}`}>
                              <Feather name="alert-triangle" size={12} color="#facc15" />
                              <Text style={styles.trimUnverifiableText}>
                                This clip can&apos;t be trimmed — its length couldn&apos;t be measured. Re-upload to enable trimming, or remove it from the reel.
                              </Text>
                            </View>
                          )}
                          {m?.mediaType === "video" && typeof m.durationSeconds === "number" && m.durationSeconds > 0 && (() => {
                            const startMinusOff = trimStepDisabled(c, "startSec", -TRIM_STEP);
                            const startPlusOff = trimStepDisabled(c, "startSec", TRIM_STEP);
                            const lenMinusOff = trimStepDisabled(c, "durationSec", -TRIM_STEP);
                            const lenPlusOff = trimStepDisabled(c, "durationSec", TRIM_STEP);
                            return (
                              <View style={styles.trimRow}>
                                <View style={styles.trimControl}>
                                  <Text style={styles.trimLabel}>Start</Text>
                                  <TouchableOpacity
                                    disabled={startMinusOff}
                                    style={[styles.trimStepBtn, startMinusOff && { opacity: 0.3 }]}
                                    onPress={() => adjustClipTrim(c.mediaId, "startSec", -TRIM_STEP)}
                                  >
                                    <Feather name="minus" size={12} color="#fff" />
                                  </TouchableOpacity>
                                  <Text style={styles.trimValue}>{(c.startSec ?? 0).toFixed(1)}s</Text>
                                  <TouchableOpacity
                                    disabled={startPlusOff}
                                    style={[styles.trimStepBtn, startPlusOff && { opacity: 0.3 }]}
                                    onPress={() => adjustClipTrim(c.mediaId, "startSec", TRIM_STEP)}
                                  >
                                    <Feather name="plus" size={12} color="#fff" />
                                  </TouchableOpacity>
                                </View>
                                <View style={styles.trimControl}>
                                  <Text style={styles.trimLabel}>Length</Text>
                                  <TouchableOpacity
                                    disabled={lenMinusOff}
                                    style={[styles.trimStepBtn, lenMinusOff && { opacity: 0.3 }]}
                                    onPress={() => adjustClipTrim(c.mediaId, "durationSec", -TRIM_STEP)}
                                  >
                                    <Feather name="minus" size={12} color="#fff" />
                                  </TouchableOpacity>
                                  <Text style={styles.trimValue}>
                                    {(c.durationSec ?? DEFAULT_CLIP_DURATION).toFixed(1)}s
                                  </Text>
                                  <TouchableOpacity
                                    disabled={lenPlusOff}
                                    style={[styles.trimStepBtn, lenPlusOff && { opacity: 0.3 }]}
                                    onPress={() => adjustClipTrim(c.mediaId, "durationSec", TRIM_STEP)}
                                  >
                                    <Feather name="plus" size={12} color="#fff" />
                                  </TouchableOpacity>
                                </View>
                                {typeof m?.durationSeconds === "number" && m.durationSeconds > 0 && (
                                  <Text style={styles.trimSourceMeta}>of {m.durationSeconds}s</Text>
                                )}
                                <TouchableOpacity
                                  style={[styles.trimControl, !m.url && { opacity: 0.4 }]}
                                  disabled={!m.url}
                                  onPress={() => setPreviewClipMediaId(c.mediaId)}
                                >
                                  <Feather name="play" size={12} color={Colors.primary} />
                                  <Text style={[styles.trimLabel, { color: Colors.primary, marginLeft: 2, marginRight: 0 }]}>
                                    Preview
                                  </Text>
                                </TouchableOpacity>
                              </View>
                            );
                          })()}
                          {trimClampedMediaIds.includes(c.mediaId) && (
                            <View style={styles.trimClamped} testID={`trim-clamped-${c.mediaId}`}>
                              <Feather name="scissors" size={12} color="#facc15" />
                              <Text style={styles.trimClampedText}>
                                Trimmed to fit the source video
                              </Text>
                            </View>
                          )}
                        </View>
                        <View style={{ flexDirection: "column", gap: 4 }}>
                          <TouchableOpacity
                            disabled={i === 0}
                            onPress={() => moveClip(c.mediaId, -1)}
                            style={[styles.clipMoveBtn, i === 0 && { opacity: 0.3 }]}
                          >
                            <Feather name="arrow-up" size={14} color="#fff" />
                          </TouchableOpacity>
                          <TouchableOpacity
                            disabled={i === draftClips.length - 1}
                            onPress={() => moveClip(c.mediaId, 1)}
                            style={[styles.clipMoveBtn, i === draftClips.length - 1 && { opacity: 0.3 }]}
                          >
                            <Feather name="arrow-down" size={14} color="#fff" />
                          </TouchableOpacity>
                        </View>
                        <TouchableOpacity
                          onPress={() => toggleClip(c.mediaId)}
                          style={[styles.clipMoveBtn, { backgroundColor: "#3a1a1a" }]}
                        >
                          <Feather name="x" size={14} color="#f87171" />
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </View>
              )}

              {candidatesLoading ? (
                <LoadingSpinner color={Colors.primary} style={{ marginVertical: 12 }} />
              ) : candidates.length === 0 ? (
                <Text style={styles.helpText}>
                  No photos or videos available yet{draftTournamentId ? " for this tournament" : ""}. Upload media to your round and they will show up here.
                </Text>
              ) : (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
                  {candidates.map(m => {
                    const selected = draftClips.some(c => c.mediaId === m.id);
                    return (
                      <TouchableOpacity
                        key={m.id}
                        onPress={() => toggleClip(m.id)}
                        style={[styles.candidateCard, selected && styles.candidateCardActive]}
                      >
                        {m.thumbnailUrl ? (
                          <Image source={{ uri: absUrl(m.thumbnailUrl) }} style={styles.candidateThumb} />
                        ) : (
                          <View style={[styles.candidateThumb, { alignItems: "center", justifyContent: "center" }]}>
                            <Feather name={m.mediaType === "video" ? "video" : "image"} size={22} color={Colors.tabIconDefault} />
                          </View>
                        )}
                        {m.mediaType === "video" && (
                          <View style={styles.candidateBadge}>
                            <Feather name="play" size={10} color="#fff" />
                          </View>
                        )}
                        {m.mediaType === "video" && (typeof m.durationSeconds !== "number" || m.durationSeconds <= 0) && (
                          <View
                            style={styles.candidateUnverifiableBadge}
                            testID={`candidate-unverifiable-${m.id}`}
                            accessibilityLabel="This clip can't be trimmed"
                          >
                            <Feather name="alert-triangle" size={10} color="#000" />
                          </View>
                        )}
                        {selected && (
                          <View style={styles.candidateCheck}>
                            <Feather name="check" size={14} color="#000" />
                          </View>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              )}

              <Text style={styles.label}>Template</Text>
              {templates.map(tpl => (
                <TouchableOpacity
                  key={tpl.id}
                  onPress={() => setDraftTemplate(tpl.id)}
                  style={[
                    styles.tplCard,
                    draftTemplate === tpl.id && { borderColor: tpl.primaryColor, borderWidth: 2 },
                  ]}
                >
                  <View style={[styles.tplSwatch, { backgroundColor: tpl.primaryColor }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.tplName}>{tpl.name}</Text>
                    <Text style={styles.tplDesc}>{tpl.description}</Text>
                    <Text style={styles.tplMeta}>{tpl.durationSeconds}s</Text>
                  </View>
                  {draftTemplate === tpl.id && (
                    <Feather name="check-circle" size={20} color={tpl.primaryColor} />
                  )}
                </TouchableOpacity>
              ))}

              <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
                <TouchableOpacity
                  style={[styles.primaryBtn, { flex: 1, backgroundColor: "#333" }]}
                  onPress={() => { setCreatorOpen(false); setEditorReel(null); setDraftClips([]); setTrimClampedMediaIds([]); }}
                >
                  <Text style={styles.primaryBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  disabled={submitting}
                  style={[styles.primaryBtn, { flex: 1, opacity: submitting ? 0.5 : 1 }]}
                  onPress={() => editorReel ? reRender(editorReel) : createReel()}
                >
                  {submitting
                    ? <LoadingSpinner color="#000" />
                    : <Text style={styles.primaryBtnText}>{editorReel ? "Re-render" : "Generate"}</Text>}
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Fullscreen preview */}
      <Modal
        visible={previewReel != null}
        animationType="fade"
        transparent
        onRequestClose={() => setPreviewReel(null)}
      >
        <View style={styles.previewRoot}>
          <TouchableOpacity style={styles.previewClose} onPress={() => setPreviewReel(null)}>
            <Feather name="x" size={28} color="#fff" />
          </TouchableOpacity>
          {previewReel?.outputUrl && (
            <Video
              source={{ uri: absUrl(previewReel.outputUrl) }}
              style={styles.previewVideo}
              useNativeControls
              resizeMode={ResizeMode.CONTAIN}
              shouldPlay
            />
          )}
        </View>
      </Modal>

      {/* Trim preview — plays a single video clip from `startSec` for
          `durationSec` so the player can verify the moment they captured
          before committing to a render. */}
      {(() => {
        const previewClip = previewClipMediaId != null
          ? draftClips.find(c => c.mediaId === previewClipMediaId)
          : null;
        const previewMedia = previewClip ? candidateById.get(previewClip.mediaId) : null;
        const committedStart = previewClip?.startSec ?? 0;
        const committedDur = previewClip?.durationSec ?? DEFAULT_CLIP_DURATION;
        // While dragging a handle, show the live drag values; otherwise use
        // the committed trim window from draftClips.
        const startSec = dragPreview?.startSec ?? committedStart;
        const durationSec = dragPreview?.durationSec ?? committedDur;
        const sourceDur = typeof previewMedia?.durationSeconds === "number" && previewMedia.durationSeconds > 0
          ? previewMedia.durationSeconds
          : null;
        const endMs = Math.round((startSec + durationSec) * 1000);
        const startMs = Math.round(startSec * 1000);
        // Anchor pan responder math at the committed values — never the
        // live drag values, which would feed back into themselves.
        dragRef.current = {
          mediaId: previewClipMediaId,
          baseStart: committedStart,
          baseDur: committedDur,
          sourceDur: sourceDur ?? 0,
          width: timelineWidth,
        };
        const startPct = sourceDur ? Math.max(0, Math.min(1, startSec / sourceDur)) : 0;
        const endPct = sourceDur ? Math.max(0, Math.min(1, (startSec + durationSec) / sourceDur)) : 1;
        const close = () => {
          // Pause/unload before tearing down the modal so audio/video doesn't
          // linger on slow platforms.
          previewVideoRef.current?.pauseAsync().catch(() => { /* not loaded */ });
          setPreviewClipMediaId(null);
          setDragPreview(null);
          setPlayheadMs(null);
          currentDragRef.current = null;
          tapPreviewEndMsRef.current = null;
        };
        const replay = async () => {
          // Replaying the trim window cancels any in-progress tap-scrub.
          tapPreviewEndMsRef.current = null;
          try {
            await previewVideoRef.current?.setPositionAsync(startMs);
            await previewVideoRef.current?.playAsync();
            setPlayheadMs(startMs);
          } catch { /* video not ready yet */ }
        };
        // Tap-to-seek (Task #995): tapping anywhere on the timeline track
        // outside the handles seeks the preview to that timestamp and plays
        // a short window from there. Handle drags claim the gesture
        // responder before this fires (their PanResponder returns true from
        // onStartShouldSetPanResponder), so we don't accidentally scrub
        // when the user grabs a handle.
        const tapPreviewWindowSec = 2;
        const handleTrackTap = (locationX: number) => {
          const { sourceDur: srcDur, width } = dragRef.current;
          if (srcDur <= 0 || width <= 0) return;
          const seekSec = Math.max(0, Math.min(srcDur, (locationX / width) * srcDur));
          const seekMs = Math.round(seekSec * 1000);
          const endSec = Math.min(srcDur, seekSec + tapPreviewWindowSec);
          tapPreviewEndMsRef.current = Math.round(endSec * 1000);
          // Snap the playhead visually right away so it doesn't briefly
          // linger at the previous position while we wait for the player
          // to seek and emit its next status tick.
          setPlayheadMs(seekMs);
          (async () => {
            try {
              await previewVideoRef.current?.setPositionAsync(seekMs);
              await previewVideoRef.current?.playAsync();
            } catch { /* video not ready yet */ }
          })();
        };
        return (
          <Modal
            visible={previewClipMediaId != null}
            animationType="fade"
            transparent
            onRequestClose={close}
          >
            <View style={styles.modalRoot}>
              <View style={styles.trimPreviewSheet}>
                <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
                  <Text style={[styles.sheetTitle, { flex: 1, marginBottom: 0 }]}>Trim preview</Text>
                  <TouchableOpacity onPress={close} style={styles.iconBtn}>
                    <Feather name="x" size={22} color="#fff" />
                  </TouchableOpacity>
                </View>
                {previewMedia?.url ? (
                  <Video
                    ref={previewVideoRef}
                    key={previewMedia.id}
                    source={{ uri: absUrl(previewMedia.url) }}
                    style={styles.trimPreviewVideo}
                    resizeMode={ResizeMode.CONTAIN}
                    useNativeControls={false}
                    positionMillis={startMs}
                    shouldPlay
                    isLooping={false}
                    onLoad={async () => {
                      try {
                        await previewVideoRef.current?.setPositionAsync(startMs);
                        await previewVideoRef.current?.playAsync();
                        setPlayheadMs(startMs);
                      } catch { /* ignore */ }
                    }}
                    onPlaybackStatusUpdate={(status) => {
                      if (!status.isLoaded) return;
                      // While a tap-scrub is active, pause at its window
                      // end instead of the committed trim end.
                      const stopAtMs = tapPreviewEndMsRef.current ?? endMs;
                      // Once we've reached/passed the (possibly tap-scrub)
                      // window end, always snap the playhead back to the
                      // trim start so the visual matches the looping
                      // behavior of replay (Task #994), and clear any
                      // active tap-scrub end marker (Task #995).
                      if (status.positionMillis >= stopAtMs) {
                        if (status.isPlaying) {
                          previewVideoRef.current?.pauseAsync().catch(() => {});
                        }
                        if (tapPreviewEndMsRef.current != null) {
                          tapPreviewEndMsRef.current = null;
                        }
                        setPlayheadMs(startMs);
                        return;
                      }
                      setPlayheadMs(status.positionMillis);
                    }}
                  />
                ) : (
                  <View style={[styles.trimPreviewVideo, { alignItems: "center", justifyContent: "center" }]}>
                    <Text style={styles.helpText}>Video not available.</Text>
                  </View>
                )}
                {/* Draggable timeline (Task #854). Shows the full source as
                    a horizontal track with a highlighted trim window between
                    two draggable handles. We only render this when we know
                    the source duration — for legacy videos missing duration
                    metadata, the +/- steppers below are still available. */}
                {sourceDur != null && previewMedia?.url ? (
                  <View
                    style={styles.timelineTrack}
                    onLayout={(e) => setTimelineWidth(e.nativeEvent.layout.width)}
                    onStartShouldSetResponder={() => true}
                    onResponderRelease={(e) => handleTrackTap(e.nativeEvent.locationX)}
                  >
                    {timelineWidth > 0 && (
                      <>
                        <View
                          style={[
                            styles.timelineWindow,
                            {
                              left: startPct * timelineWidth,
                              width: Math.max(2, (endPct - startPct) * timelineWidth),
                            },
                          ]}
                        />
                        <View
                          {...startHandlePan.panHandlers}
                          style={[
                            styles.timelineHandle,
                            { left: startPct * timelineWidth - TIMELINE_HANDLE_WIDTH / 2 },
                          ]}
                          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                        >
                          <View style={styles.timelineHandleGrip} />
                        </View>
                        <View
                          {...endHandlePan.panHandlers}
                          style={[
                            styles.timelineHandle,
                            { left: endPct * timelineWidth - TIMELINE_HANDLE_WIDTH / 2 },
                          ]}
                          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                        >
                          <View style={styles.timelineHandleGrip} />
                        </View>
                        {/* Live playhead (Task #994). Rendered last so it
                            sits above the trim window, but with
                            pointerEvents="none" so it never steals touches
                            from the start/end drag handles. Only shown when
                            we have a playback position within the source. */}
                        {playheadMs != null && sourceDur > 0 && (() => {
                          const playSec = playheadMs / 1000;
                          const playPct = Math.max(0, Math.min(1, playSec / sourceDur));
                          return (
                            <View
                              pointerEvents="none"
                              style={[
                                styles.timelinePlayhead,
                                { left: playPct * timelineWidth - 1 },
                              ]}
                            />
                          );
                        })()}
                      </>
                    )}
                  </View>
                ) : null}
                {sourceDur != null && (
                  <View style={styles.timelineLabels}>
                    <Text style={styles.timelineLabel}>0s</Text>
                    <Text style={styles.timelineLabel}>{sourceDur.toFixed(1)}s</Text>
                  </View>
                )}
                <Text style={[styles.helpText, { marginTop: 8 }]}>
                  Playing from {startSec.toFixed(1)}s for {durationSec.toFixed(1)}s.
                  {sourceDur != null
                    ? " Drag the handles to set the trim window, tap the timeline to scrub, or use the steppers below."
                    : " Adjust start or length below and replay to fine-tune."}
                </Text>
                {previewClip && (
                  <View style={[styles.trimRow, { marginTop: 4 }]}>
                    <View style={styles.trimControl}>
                      <Text style={styles.trimLabel}>Start</Text>
                      <TouchableOpacity
                        style={styles.trimStepBtn}
                        onPress={() => adjustClipTrim(previewClip.mediaId, "startSec", -TRIM_STEP)}
                      >
                        <Feather name="minus" size={12} color="#fff" />
                      </TouchableOpacity>
                      <Text style={styles.trimValue}>{startSec.toFixed(1)}s</Text>
                      <TouchableOpacity
                        style={styles.trimStepBtn}
                        onPress={() => adjustClipTrim(previewClip.mediaId, "startSec", TRIM_STEP)}
                      >
                        <Feather name="plus" size={12} color="#fff" />
                      </TouchableOpacity>
                    </View>
                    <View style={styles.trimControl}>
                      <Text style={styles.trimLabel}>Length</Text>
                      <TouchableOpacity
                        style={styles.trimStepBtn}
                        onPress={() => adjustClipTrim(previewClip.mediaId, "durationSec", -TRIM_STEP)}
                      >
                        <Feather name="minus" size={12} color="#fff" />
                      </TouchableOpacity>
                      <Text style={styles.trimValue}>{durationSec.toFixed(1)}s</Text>
                      <TouchableOpacity
                        style={styles.trimStepBtn}
                        onPress={() => adjustClipTrim(previewClip.mediaId, "durationSec", TRIM_STEP)}
                      >
                        <Feather name="plus" size={12} color="#fff" />
                      </TouchableOpacity>
                    </View>
                    <TouchableOpacity style={styles.trimControl} onPress={replay}>
                      <Feather name="rotate-ccw" size={12} color={Colors.primary} />
                      <Text style={[styles.trimLabel, { color: Colors.primary, marginLeft: 4, marginRight: 0 }]}>
                        Replay
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            </View>
          </Modal>
        );
      })()}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: "#222",
  },
  iconBtn: { padding: 6 },
  headerTitle: { color: "#fff", fontSize: 17, fontWeight: "600", flex: 1, textAlign: "center" },
  quotaBar: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: "#111" },
  quotaText: { color: Colors.tabIconDefault, fontSize: 12 },
  // Task #1012 — sort chips above the gallery list.
  sortBar: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, paddingHorizontal: 16, paddingTop: 8 },
  sortLabel: { color: Colors.tabIconDefault, fontSize: 11, marginRight: 2 },
  sortChip: { borderWidth: 1, borderColor: "#2a2a2a", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  sortChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  sortChipText: { color: "#fff", fontSize: 11 },
  sortChipTextActive: { color: "#000", fontWeight: "600" },
  card: {
    backgroundColor: "#1a1a1a", borderRadius: 12, padding: 14, marginBottom: 12,
    borderWidth: 1, borderColor: "#252525",
  },
  cardTitle: { color: "#fff", fontSize: 15, fontWeight: "600" },
  cardMeta: { color: Colors.tabIconDefault, fontSize: 12, marginTop: 2 },
  statusPill: { borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  engagementBadge: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.08)",
    marginRight: 6,
  },
  engagementBadgeText: { color: "#fff", fontSize: 11, fontWeight: "600", fontVariant: ["tabular-nums"] },
  statusText: { fontSize: 11, fontWeight: "600", textTransform: "uppercase" },
  video: { width: "100%", height: 200, borderRadius: 8, backgroundColor: "#000", marginTop: 4 },
  renderingBox: {
    flexDirection: "row", alignItems: "center", padding: 16, backgroundColor: "#0f0f0f",
    borderRadius: 8, marginTop: 4,
  },
  progressTitle: { color: "#fff", fontSize: 13, fontWeight: "600" },
  progressMeta: { color: Colors.tabIconDefault, fontSize: 12, marginTop: 3 },
  actionBtn: {
    flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 8,
    backgroundColor: "#252525", borderRadius: 8,
  },
  actionText: { color: "#fff", fontSize: 12, fontWeight: "500" },
  trendToggleBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 10, paddingVertical: 5, backgroundColor: "#1a1a1a",
    borderRadius: 8, borderWidth: 1, borderColor: "#252525",
  },
  trendToggleText: { color: Colors.primary, fontSize: 11, fontWeight: "600" },
  trendDayChip: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
    borderWidth: 1, borderColor: "#252525", backgroundColor: "#1a1a1a",
  },
  trendDayChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  trendDayChipText: { color: "#fff", fontSize: 11 },
  trendDayChipTextActive: { color: "#000", fontWeight: "700" },
  trendPanel: {
    marginTop: 8, padding: 10, borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.06)",
  },
  trendLegend: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 6 },
  trendLegendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  trendLegendDot: { width: 8, height: 8, borderRadius: 4 },
  trendLegendText: { color: Colors.tabIconDefault, fontSize: 10 },
  trendEmpty: { color: Colors.tabIconDefault, fontSize: 11, paddingVertical: 8, textAlign: "center" },
  bestHourBadge: {
    flexDirection: "row", alignItems: "center", alignSelf: "flex-start",
    gap: 4, marginTop: 8,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
    borderWidth: 1, borderColor: "#252525", backgroundColor: "rgba(255,255,255,0.04)",
  },
  bestHourText: { color: Colors.primary, fontSize: 11, fontWeight: "600" },
  hourPanel: { marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.06)" },
  hourPanelLabel: { color: Colors.tabIconDefault, fontSize: 10 },
  hourPanelPeak: { color: "#a855f7", fontSize: 10, fontWeight: "600" },
  primaryBtn: {
    backgroundColor: Colors.primary, padding: 13, borderRadius: 10,
    alignItems: "center", marginTop: 18, paddingHorizontal: 22,
  },
  primaryBtnText: { color: "#000", fontWeight: "600", fontSize: 14 },
  modalRoot: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: "#0f0f0f", borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, maxHeight: "88%",
  },
  sheetTitle: { color: "#fff", fontSize: 18, fontWeight: "700", marginBottom: 12 },
  label: { color: Colors.tabIconDefault, fontSize: 12, marginTop: 12, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 },
  input: {
    backgroundColor: "#1a1a1a", borderRadius: 8, color: "#fff", padding: 12, fontSize: 14,
    borderWidth: 1, borderColor: "#252525",
  },
  chip: {
    paddingHorizontal: 12, paddingVertical: 8, backgroundColor: "#1a1a1a",
    borderRadius: 16, marginRight: 8, borderWidth: 1, borderColor: "#252525",
    maxWidth: 200,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  chipText: { color: "#fff", fontSize: 12 },
  chipTextActive: { color: "#000", fontWeight: "600" },
  tplCard: {
    flexDirection: "row", alignItems: "center", padding: 12, backgroundColor: "#1a1a1a",
    borderRadius: 10, marginBottom: 8, borderWidth: 1, borderColor: "#252525", gap: 12,
  },
  tplSwatch: { width: 38, height: 38, borderRadius: 8 },
  tplName: { color: "#fff", fontSize: 14, fontWeight: "600" },
  tplDesc: { color: Colors.tabIconDefault, fontSize: 12, marginTop: 2 },
  tplMeta: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 2 },
  helpText: { color: Colors.tabIconDefault, fontSize: 12, lineHeight: 16, marginBottom: 4 },
  clipRow: {
    flexDirection: "row", alignItems: "center", gap: 8, padding: 8,
    backgroundColor: "#1a1a1a", borderRadius: 10, marginBottom: 8,
    borderWidth: 1, borderColor: "#252525",
  },
  clipIndex: {
    width: 22, height: 22, borderRadius: 11, backgroundColor: Colors.primary,
    alignItems: "center", justifyContent: "center",
  },
  clipIndexText: { color: "#000", fontSize: 11, fontWeight: "700" },
  clipThumb: { width: 48, height: 48, borderRadius: 6, backgroundColor: "#0a0a0a" },
  clipThumbPlay: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.35)", borderRadius: 6,
  },
  clipCaptionInput: {
    backgroundColor: "#0f0f0f", color: "#fff", borderRadius: 6, paddingHorizontal: 8,
    paddingVertical: 6, fontSize: 12, borderWidth: 1, borderColor: "#252525",
  },
  clipMeta: { color: Colors.tabIconDefault, fontSize: 10, marginTop: 4 },
  suggestionRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 6 },
  suggestionChip: {
    flexDirection: "row", alignItems: "center",
    borderRadius: 12, backgroundColor: "#0a1f12",
    borderWidth: 1, borderColor: Colors.primary,
    maxWidth: 220, overflow: "hidden",
  },
  suggestionChipFav: { backgroundColor: "#241c08", borderColor: "#facc15" },
  suggestionChipMain: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, flexShrink: 1,
  },
  suggestionChipText: { color: Colors.primary, fontSize: 10, fontWeight: "500" },
  suggestionStarBtn: {
    paddingHorizontal: 6, paddingVertical: 4,
    borderLeftWidth: 1, borderLeftColor: "rgba(255,255,255,0.08)",
  },
  clipMoveBtn: {
    width: 28, height: 22, borderRadius: 6, backgroundColor: "#252525",
    alignItems: "center", justifyContent: "center",
  },
  trimRow: { flexDirection: "row", gap: 8, marginTop: 6, flexWrap: "wrap" },
  trimControl: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "#0f0f0f", borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3,
    borderWidth: 1, borderColor: "#252525",
  },
  trimLabel: { color: Colors.tabIconDefault, fontSize: 10, marginRight: 2 },
  trimStepBtn: {
    width: 22, height: 22, borderRadius: 4, backgroundColor: "#252525",
    alignItems: "center", justifyContent: "center",
  },
  trimValue: { color: "#fff", fontSize: 11, fontWeight: "600", minWidth: 32, textAlign: "center" },
  trimSourceMeta: { color: Colors.tabIconDefault, fontSize: 10, alignSelf: "center" },
  trimUnverifiable: {
    flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 6,
    backgroundColor: "rgba(250, 204, 21, 0.08)", borderRadius: 6,
    borderWidth: 1, borderColor: "rgba(250, 204, 21, 0.35)",
    paddingHorizontal: 8, paddingVertical: 6,
  },
  trimUnverifiableText: { color: "#facc15", fontSize: 11, flex: 1, lineHeight: 14 },
  // Task #1961 — surfaced after a save when the server clamped the trim
  // window to fit the source video. Shares the warning palette with the
  // unverifiable banner so the editor's "trim attention" cues are
  // visually consistent.
  trimClamped: {
    flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6,
    backgroundColor: "rgba(250, 204, 21, 0.08)", borderRadius: 6,
    borderWidth: 1, borderColor: "rgba(250, 204, 21, 0.35)",
    paddingHorizontal: 8, paddingVertical: 6,
  },
  trimClampedText: { color: "#facc15", fontSize: 11, flex: 1, lineHeight: 14 },
  candidateUnverifiableBadge: {
    position: "absolute", top: 4, right: 4,
    backgroundColor: "rgba(250, 204, 21, 0.9)",
    width: 18, height: 18, borderRadius: 9,
    alignItems: "center", justifyContent: "center",
  },
  candidateCard: {
    width: 72, height: 72, marginRight: 8, borderRadius: 8, overflow: "hidden",
    backgroundColor: "#1a1a1a", borderWidth: 2, borderColor: "transparent",
    position: "relative",
  },
  candidateCardActive: { borderColor: Colors.primary },
  candidateThumb: { width: "100%", height: "100%" },
  candidateBadge: {
    position: "absolute", top: 4, left: 4, backgroundColor: "rgba(0,0,0,0.6)",
    paddingHorizontal: 4, paddingVertical: 2, borderRadius: 4,
  },
  candidateCheck: {
    position: "absolute", bottom: 4, right: 4, width: 20, height: 20, borderRadius: 10,
    backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center",
  },
  trimPreviewSheet: {
    backgroundColor: "#0f0f0f", borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 16, paddingBottom: 28,
  },
  trimPreviewVideo: {
    width: "100%", aspectRatio: 16 / 9, backgroundColor: "#000", borderRadius: 8,
  },
  timelineTrack: {
    height: 28, marginTop: 12, backgroundColor: "#252525", borderRadius: 6,
    position: "relative", justifyContent: "center",
  },
  timelineWindow: {
    position: "absolute", top: 0, bottom: 0,
    backgroundColor: "rgba(74, 222, 128, 0.25)",
    borderTopWidth: 2, borderBottomWidth: 2, borderColor: Colors.primary,
  },
  timelineHandle: {
    position: "absolute", top: -4, bottom: -4, width: TIMELINE_HANDLE_WIDTH,
    backgroundColor: Colors.primary, borderRadius: 4,
    alignItems: "center", justifyContent: "center",
  },
  timelineHandleGrip: {
    width: 2, height: 14, backgroundColor: "#000", borderRadius: 1,
  },
  timelinePlayhead: {
    position: "absolute", top: -6, bottom: -6, width: 2,
    backgroundColor: "#fff", borderRadius: 1,
  },
  timelineLabels: {
    flexDirection: "row", justifyContent: "space-between", marginTop: 4,
  },
  timelineLabel: { color: Colors.tabIconDefault, fontSize: 10 },
  previewRoot: { flex: 1, backgroundColor: "#000", justifyContent: "center" },
  previewClose: { position: "absolute", top: 50, right: 20, zIndex: 10, padding: 8 },
  previewVideo: { width: "100%", aspectRatio: 9 / 16 },
});
