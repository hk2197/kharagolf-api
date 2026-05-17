import React, { useState, useCallback, useEffect, useRef } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  captureRef } from "react-native-view-shot";
import * as Sharing from "expo-sharing";
import * as MediaLibrary from "expo-media-library";
import Svg,
  { Polyline,
  Circle,
  Line as SvgLine,
  Text as SvgText } from "react-native-svg";
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  RefreshControl,
  Alert,
  Linking,
  Modal,
  Pressable,
  Share,
  Switch,
  TextInput,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { Ionicons, Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { fetchPortal, putPortal, postPortal, deletePortal } from "@/utils/api";
import { RoundHrHeatStrip, hrColor, type HrRound } from "@/components/HrStrip";
import { useAuth } from "@/context/auth";
import { getLocale } from "@/i18n";
import { formatRelativeTime } from "@/i18n/relativeTime";
import { useTranslation } from "react-i18next";

type StatsPeriod = "allTime" | "thisYear" | "last5rounds" | "last10rounds" | "last12rounds" | "last20rounds";

// Task #1643 — picker also surfaces "auto" so a player can let their handicap
// choose the right baseline (and re-enable auto after pinning).
type SGBaseline = "scratch" | "10" | "18";
type SgPickerValue = "auto" | SGBaseline;

interface StrokesGained {
  sgPutting: number | null;
  sgApproach: number | null;
  sgATG: number | null;
  sgOffTheTee: number | null;
  sgTotal: number | null;
  trackedRounds: number;
  baseline: string;
  sgPuttingMeasuredRounds?: number;
  sgPuttingEstimatedRounds?: number;
  // Task #1643 — auto-pick + pin-override metadata mirroring the
  // proximity-by-club card. `preferredBaseline` is what the player has
  // pinned (or "auto"), `primaryBaseline` is what was actually used to
  // compute the numbers, and `baselineSource` lets us pick the right
  // copy ("Auto-picked from your 12.4 handicap" vs "Pinned to 10-hcp").
  preferredBaseline?: SgPickerValue;
  primaryBaseline?: SGBaseline;
  baselineSource?: "preference" | "handicap" | "default";
  handicapIndex?: number | null;
  // Task #2048 — one-time "your benchmark moved" notice surfaced when
  // the player is on auto and the handicap-derived cohort has crossed a
  // threshold since their last visit. `null` when there's nothing to
  // flag (player has a pinned preference, no handicap on file, the
  // first-ever fetch we just lazy-seeded, or the cohort hasn't moved).
  baselineChange?: { previousBaseline: SGBaseline; currentBaseline: SGBaseline } | null;
}

interface PlayerStats {
  roundsPlayed: number;
  scoringAvg: number | null;
  bestRound: number | null;
  worstRound: number | null;
  eagles: number; birdies: number; pars: number; bogeys: number; doublePlus: number;
  fairwayPct: number | null;
  girPct: number | null;
  avgPutts: number | null;
  putting?: { holesTracked: number; onePutts: number; threePlusPutts: number; onePuttPct: number | null; threePlusPuttPct: number | null } | null;
  holeAverages: { holeNumber: number; avgStrokes: number | null; avgToPar: number | null; count: number }[];
  recentRounds: { playerId: number; tournamentId: number; round: number; gross: number; par: number; toPar: number; fairwayPct: number | null; girPct: number | null; avgPutts: number | null }[];
  strokesGained?: StrokesGained | null;
  handicapTrend?: { handicapIndex: number; recordedAt: string | null; tournamentId: number }[];
  committeeAdjustments?: { previousHandicapIndex: number | null; newHandicapIndex: number; adjustmentReason: string; adjustedAt: string }[];
  courseBreakdown?: { courseId: number; courseName: string; rounds: number; avgGross: number; bestGross: number | null }[];
  shortGame?: { sandSavePct: number | null; upAndDownPct: number | null };
  eventBreakdown?: { tournamentRounds: number; generalPlayRounds: number; tournamentScoringAvg: number | null; generalPlayScoringAvg: number | null } | null;
}

interface Achievement {
  id: number; badgeType: string; badgeLabel: string; badgeIcon: string; badgeCategory: string;
  earnedAt: string;
}

interface WearableConnection {
  id: number; provider: string; status: string; connectedAt: string | null; updatedAt: string | null;
}

type Tab = "stats" | "achievements" | "devices" | "handicap" | "clubs" | "practice" | "prizes" | "compare";
type PrizeAward = { awardId: number; categoryName: string; description: string | null; prizeValue: number | null; currency: string; notes: string | null; awardedAt: string; tournamentId: number; tournamentName: string };

type ClubEntry = { club: string | null; avgDistance: number | null; minDistance: number | null; maxDistance: number | null; shotCount: number };
type PracticeSession = {
  id: number;
  sessionType: string;
  durationMinutes: number | null;
  notes: string | null;
  clubFocus: string | null;
  sessionDate: string;
  // Task #1641 — set when a session was logged from a "Work on This Club"
  // coaching tip. Drives the "From coaching tip" badge in the session list.
  source: string | null;
  clubKey: string | null;
  practiceDistanceYards: number | null;
};
type PracticeStats = { thisWeek: number; thisMonth: number; streak: number; total: number; heatmap: Record<string, number> };

// Task #1609 — weather buckets backed by fewer than this many rounds get
// rendered with reduced opacity + a "limited sample" tag so a single freak
// round doesn't read as a real trend.
const MIN_TRUSTWORTHY_WEATHER_ROUNDS = 3;

// Task #1997 — same idea as the weather buckets above, but for shot counts:
// proximity averages from a couple of approach shots wildly swing the bar,
// so anything below this threshold renders faded and is named in a small
// caption underneath the chart.
const MIN_TRUSTWORTHY_SAMPLE = 5;

const SESSION_TYPE_META: Record<string, { label: string; icon: string }> = {
  range: { label: "Driving Range", icon: "🏌️" },
  putting: { label: "Putting Green", icon: "⛳" },
  short_game: { label: "Short Game", icon: "🏖️" },
  on_course: { label: "On Course", icon: "🌿" },
  simulator: { label: "Simulator", icon: "🖥️" },
  other: { label: "Other", icon: "🎯" },
};

const PROVIDER_META: Record<string, { label: string; icon: string; description: string }> = {
  garmin: { label: "Garmin Connect", icon: "⌚", description: "Auto-sync from Garmin GPS watch" },
  arccos: { label: "Arccos Caddie", icon: "📡", description: "Automatic shot tracking" },
  gpx: { label: "GPX Import", icon: "🗺️", description: "GPS file from any device" },
  apple_health: { label: "Apple Health", icon: "🍎", description: "Sync from Apple Watch" },
};

interface HcpSimResult {
  courseHandicap: number;
  playingHandicap: number;
  netPar: number;
  parDiff: number;
  projectedHandicapIndex: number | null;
  differential: number | null;
}

function HandicapSimulatorTab({ token }: { token: string | null }) {
  const [handicapIndex, setHandicapIndex] = useState(18.0);
  const [courseSlope, setCourseSlope] = useState(113);
  const [courseRating, setCourseRating] = useState(72.0);
  const [coursePar, setCoursePar] = useState(72);
  const [handicapAllowance, setHandicapAllowance] = useState(100);
  const [grossScore, setGrossScore] = useState<number | null>(null);
  const [grossEnabled, setGrossEnabled] = useState(false);
  const [result, setResult] = useState<HcpSimResult | null>(null);
  const [loading, setLoading] = useState(false);

  const simulate = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        handicapIndex: String(handicapIndex),
        courseSlope: String(courseSlope),
        courseRating: String(courseRating),
        coursePar: String(coursePar),
        handicapAllowance: String(handicapAllowance),
      });
      if (grossEnabled && grossScore !== null) {
        params.set("grossScore", String(grossScore));
      }
      const data = await fetchPortal<{
        courseHandicap: number; playingHandicap: number; netPar: number; parDiff: number;
        projectedHandicapIndex: number | null; differential: number | null;
      }>(`/handicap/simulate?${params}`, token);
      setResult({
        courseHandicap: data.courseHandicap,
        playingHandicap: data.playingHandicap,
        netPar: data.netPar,
        parDiff: data.parDiff,
        projectedHandicapIndex: data.projectedHandicapIndex ?? null,
        differential: data.differential ?? null,
      });
    } catch {
      Alert.alert("Error", "Could not calculate handicap.");
    } finally {
      setLoading(false);
    }
  }, [token, handicapIndex, courseSlope, courseRating, coursePar, handicapAllowance, grossEnabled, grossScore]);

  React.useEffect(() => { simulate(); }, [handicapIndex, courseSlope, courseRating, coursePar, handicapAllowance, grossEnabled, grossScore]);

  const indexDelta = result?.projectedHandicapIndex != null ? result.projectedHandicapIndex - handicapIndex : null;

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={{ marginHorizontal: 16, marginTop: 16, backgroundColor: "rgba(255,255,255,0.05)", borderRadius: 16, padding: 16 }}>
        <Text style={{ fontSize: 15, fontWeight: "800", color: "#C9A84C", marginBottom: 4 }}>⛳ Handicap Calculator</Text>
        <Text style={{ fontSize: 12, color: Colors.textSecondary, marginBottom: 16 }}>
          Adjust parameters to see your World Handicap System course handicap.
        </Text>

        <HcpSlider label="Handicap Index" value={handicapIndex} min={0} max={54} step={0.1} onValue={setHandicapIndex} format={v => v.toFixed(1)} />
        <HcpSlider label="Slope Rating" value={courseSlope} min={55} max={155} step={1} onValue={setCourseSlope} format={v => String(v)} />
        <HcpSlider label="Course Rating" value={courseRating} min={60} max={80} step={0.1} onValue={setCourseRating} format={v => v.toFixed(1)} />
        <HcpSlider label="Par" value={coursePar} min={68} max={74} step={1} onValue={setCoursePar} format={v => String(v)} />
        <HcpSlider label="Allowance %" value={handicapAllowance} min={50} max={100} step={5} onValue={setHandicapAllowance} format={v => `${v}%`} />

        {/* What-If Gross Score toggle */}
        <View style={{ marginBottom: 8 }}>
          <TouchableOpacity
            onPress={() => {
              const next = !grossEnabled;
              setGrossEnabled(next);
              if (next && grossScore === null) setGrossScore(coursePar + 10);
            }}
            style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 }}
          >
            <View style={{ width: 36, height: 20, borderRadius: 10, backgroundColor: grossEnabled ? "#C9A84C" : "rgba(255,255,255,0.12)", justifyContent: "center", paddingHorizontal: 2 }}>
              <View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: "#fff", alignSelf: grossEnabled ? "flex-end" : "flex-start" }} />
            </View>
            <Text style={{ fontSize: 12, color: Colors.textSecondary, fontWeight: "600" }}>What-If: Enter Hypothetical Gross Score</Text>
          </TouchableOpacity>
          {grossEnabled && (
            <HcpSlider
              label="Hypothetical Gross Score"
              value={grossScore ?? coursePar + 10}
              min={coursePar - 10}
              max={coursePar + 40}
              step={1}
              onValue={v => setGrossScore(v)}
              format={v => String(v)}
            />
          )}
        </View>
      </View>

      {/* Results */}
      {loading ? (
        <LoadingSpinner color={Colors.primary} style={{ marginTop: 24 }} />
      ) : result ? (
        <View style={{ marginHorizontal: 16, marginTop: 12, backgroundColor: "rgba(255,255,255,0.05)", borderRadius: 16, padding: 16, gap: 12 }}>
          <Text style={{ fontSize: 14, fontWeight: "700", color: Colors.text, marginBottom: 4 }}>Results</Text>
          <ResultRow label="Course Handicap" value={`${result.courseHandicap}`} color="#C9A84C" />
          <ResultRow label="Playing Handicap" value={`${result.playingHandicap}`} color="#22c55e" />
          <ResultRow label="Net Par (vs scratch)" value={`${result.netPar} (${result.parDiff >= 0 ? "+" : ""}${result.parDiff})`} color={Colors.text} />
          {grossEnabled && result.differential !== null && (
            <ResultRow label="Score Differential" value={`${result.differential.toFixed(1)}`} color={Colors.text} />
          )}
          {grossEnabled && result.projectedHandicapIndex !== null && (
            <>
              <ResultRow
                label="Projected New HCP Index"
                value={`${result.projectedHandicapIndex.toFixed(1)}`}
                color={indexDelta != null && indexDelta < 0 ? "#4ade80" : "#fb923c"}
              />
              {indexDelta !== null && (
                <ResultRow
                  label="Change"
                  value={indexDelta > 0 ? `+${indexDelta.toFixed(1)}` : indexDelta.toFixed(1)}
                  color={indexDelta < 0 ? "#4ade80" : "#fb923c"}
                />
              )}
            </>
          )}
          <View style={{ height: 1, backgroundColor: "rgba(255,255,255,0.08)" }} />
          <Text style={{ fontSize: 11, color: Colors.textSecondary, lineHeight: 16 }}>
            WHS: Course HCP = HI × (Slope ÷ 113) + (CR − Par) × allowance%{grossEnabled ? "\nScore Differential = (113/Slope) × (Gross − CR)" : ""}
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

function HcpSlider({ label, value, min, max, step, onValue, format }: {
  label: string; value: number; min: number; max: number; step: number; onValue: (v: number) => void; format: (v: number) => string;
}) {
  return (
    <View style={{ marginBottom: 16 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
        <Text style={{ fontSize: 12, color: Colors.textSecondary, fontWeight: "600" }}>{label}</Text>
        <Text style={{ fontSize: 13, color: Colors.text, fontWeight: "700" }}>{format(value)}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <TouchableOpacity
          onPress={() => onValue(Math.max(min, Math.round((value - step) * 10) / 10))}
          style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ color: Colors.text, fontSize: 18, lineHeight: 22 }}>−</Text>
        </TouchableOpacity>
        <View style={{ flex: 1, height: 4, backgroundColor: "rgba(255,255,255,0.12)", borderRadius: 2, overflow: "hidden" }}>
          <View style={{ width: `${((value - min) / (max - min)) * 100}%`, height: 4, backgroundColor: "#C9A84C", borderRadius: 2 }} />
        </View>
        <TouchableOpacity
          onPress={() => onValue(Math.min(max, Math.round((value + step) * 10) / 10))}
          style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ color: Colors.text, fontSize: 18, lineHeight: 22 }}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function ResultRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
      <Text style={{ fontSize: 13, color: Colors.textSecondary }}>{label}</Text>
      <Text style={{ fontSize: 15, fontWeight: "800", color }}>{value}</Text>
    </View>
  );
}

function HandicapChart({
  data,
  committeeAdjustments = [],
}: {
  data: { handicapIndex: number; recordedAt: string | null; tournamentId: number }[];
  committeeAdjustments?: { previousHandicapIndex: number | null; newHandicapIndex: number; adjustmentReason: string; adjustedAt: string }[];
}) {
  const [expanded, setExpanded] = useState(false);
  const W = 320, H = 120, PAD = { l: 32, r: 8, t: 10, b: 24 };
  const vals = data.map(d => d.handicapIndex);
  const minVal = Math.min(...vals);
  const maxVal = Math.max(...vals);
  const range = maxVal - minVal || 1;
  const pts = data.map((d, i) => {
    const x = PAD.l + (i / Math.max(data.length - 1, 1)) * (W - PAD.l - PAD.r);
    const y = PAD.t + ((maxVal - d.handicapIndex) / range) * (H - PAD.t - PAD.b);
    return { x, y, val: d.handicapIndex, date: d.recordedAt };
  });
  const polyPoints = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const labels = data.length <= 8 ? data.map((d, i) => ({ i, label: d.recordedAt ? new Date(d.recordedAt).toLocaleDateString(getLocale(), { month: "short", year: "2-digit" }) : `#${i + 1}` }))
    : [0, Math.floor(data.length / 2), data.length - 1].map(i => ({ i, label: data[i].recordedAt ? new Date(data[i].recordedAt!).toLocaleDateString(getLocale(), { month: "short", year: "2-digit" }) : `#${i + 1}` }));

  // Match committee adjustment dates to closest chart data point
  const adjMarkerIndices = new Set<number>();
  for (const adj of committeeAdjustments) {
    if (!adj.adjustedAt) continue;
    const adjTime = new Date(adj.adjustedAt).getTime();
    let best = -1, bestDiff = Infinity;
    data.forEach((d, i) => {
      if (!d.recordedAt) return;
      const diff = Math.abs(new Date(d.recordedAt).getTime() - adjTime);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    });
    if (best >= 0) adjMarkerIndices.add(best);
  }

  const hasCommitteeAdj = committeeAdjustments.length > 0;

  return (
    <View style={{ overflow: "hidden" }}>
      <Svg width={W} height={H + 4}>
        <SvgLine x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={H - PAD.b + 4} stroke="rgba(255,255,255,0.1)" strokeWidth={1} />
        <SvgLine x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} stroke="rgba(255,255,255,0.1)" strokeWidth={1} />
        <SvgText x={PAD.l - 2} y={PAD.t + 4} fontSize={9} fill="rgba(255,255,255,0.4)" textAnchor="end">{maxVal.toFixed(1)}</SvgText>
        <SvgText x={PAD.l - 2} y={H - PAD.b} fontSize={9} fill="rgba(255,255,255,0.4)" textAnchor="end">{minVal.toFixed(1)}</SvgText>
        <Polyline points={polyPoints} fill="none" stroke="#C9A84C" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {pts.map((p, i) => {
          const isAdj = adjMarkerIndices.has(i);
          const isLast = i === pts.length - 1;
          if (isAdj) {
            // Orange diamond marker for committee adjustments
            const s = 5;
            return (
              <React.Fragment key={i}>
                <SvgLine x1={p.x - s} y1={p.y} x2={p.x} y2={p.y - s} stroke="#f97316" strokeWidth={1.5} />
                <SvgLine x1={p.x} y1={p.y - s} x2={p.x + s} y2={p.y} stroke="#f97316" strokeWidth={1.5} />
                <SvgLine x1={p.x + s} y1={p.y} x2={p.x} y2={p.y + s} stroke="#f97316" strokeWidth={1.5} />
                <SvgLine x1={p.x} y1={p.y + s} x2={p.x - s} y2={p.y} stroke="#f97316" strokeWidth={1.5} />
                <Circle cx={p.x} cy={p.y} r={2} fill="#f97316" />
              </React.Fragment>
            );
          }
          return <Circle key={i} cx={p.x} cy={p.y} r={isLast ? 5 : 3} fill={isLast ? "#C9A84C" : "#1a3a2a"} stroke="#C9A84C" strokeWidth={1.5} />;
        })}
        {labels.map(({ i, label }) => pts[i] && (
          <SvgText key={i} x={pts[i].x} y={H} fontSize={9} fill="rgba(255,255,255,0.4)" textAnchor="middle">{label}</SvgText>
        ))}
      </Svg>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
        <Text style={{ color: Colors.muted, fontSize: 10 }}>Trend: {data[0].handicapIndex.toFixed(1)} → {data[data.length - 1].handicapIndex.toFixed(1)}</Text>
        <Text style={{ color: data[data.length - 1].handicapIndex < data[0].handicapIndex ? "#22c55e" : "#ef4444", fontSize: 10, fontWeight: "700" }}>
          {data[data.length - 1].handicapIndex < data[0].handicapIndex ? "▼ Improved" : "▲ Increased"} by {Math.abs(data[data.length - 1].handicapIndex - data[0].handicapIndex).toFixed(1)}
        </Text>
      </View>
      {hasCommitteeAdj && (
        <>
          <TouchableOpacity
            onPress={() => setExpanded(e => !e)}
            style={{ flexDirection: "row", alignItems: "center", marginTop: 6, gap: 6 }}
            activeOpacity={0.7}
          >
            <View style={{ width: 10, height: 10, borderWidth: 1.5, borderColor: "#f97316", transform: [{ rotate: "45deg" }] }} />
            <Text style={{ color: "#f97316", fontSize: 10 }}>
              Committee adjustment ({committeeAdjustments.length}) {expanded ? "▲" : "▼ tap to view"}
            </Text>
          </TouchableOpacity>
          {expanded && (
            <View style={{ marginTop: 8, backgroundColor: "rgba(249,115,22,0.08)", borderRadius: 8, padding: 10, gap: 8 }}>
              {committeeAdjustments.map((adj, i) => (
                <View key={i} style={{ borderLeftWidth: 2, borderLeftColor: "#f97316", paddingLeft: 8 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 2 }}>
                    <Text style={{ color: Colors.muted, fontSize: 10 }}>
                      {adj.adjustedAt ? new Date(adj.adjustedAt).toLocaleDateString(getLocale()) : "—"}
                    </Text>
                    <Text style={{ color: "#f97316", fontSize: 10, fontWeight: "700" }}>
                      {adj.previousHandicapIndex != null ? `${Number(adj.previousHandicapIndex).toFixed(1)} → ` : ""}{Number(adj.newHandicapIndex).toFixed(1)}
                    </Text>
                  </View>
                  <Text style={{ color: Colors.text, fontSize: 11 }}>"{adj.adjustmentReason}"</Text>
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </View>
  );
}

interface HrPrefs { captureEnabled: boolean; baselineHrBpm: number | null }
interface HrCorrelation {
  totalHoles: number;
  totalShots: number;
  hrBogeyOrWorseAvg: number | null;
  hrParOrBetterAvg: number | null;
  delta: number | null;
  rounds: { tournamentId: number; round: number; date: string | null; avgHr: number; bogeyOrWorse: number; pars: number }[];
}

function HrHealthSection({ token }: { token: string | null }) {
  const [prefs, setPrefs] = useState<HrPrefs | null>(null);
  const [latest, setLatest] = useState<HrRound | null>(null);
  const [latestRound, setLatestRound] = useState<{ tournamentId: number; round: number } | null>(null);
  const [corr, setCorr] = useState<HrCorrelation | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const p = await fetchPortal<HrPrefs>("/health-prefs", token);
      setPrefs(p);
      // Find most recent round (any) by checking history endpoint
      const rounds = await fetchPortal<{ tournamentId: number; round: number }[]>("/hr-samples", token).catch(() => []);
      const last = rounds[0] ?? null;
      setLatestRound(last);
      if (last) {
        const data = await fetchPortal<HrRound>(`/hr-samples/round?tournamentId=${last.tournamentId}&round=${last.round}`, token);
        setLatest(data);
      } else {
        setLatest(null);
      }
      const c = await fetchPortal<HrCorrelation>("/hr-samples/correlation", token).catch(() => null);
      setCorr(c);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void reload(); }, [reload]);

  const togglePref = async (next: boolean) => {
    if (!token || !prefs) return;
    setSaving(true);
    try {
      const updated = await putPortal<HrPrefs>("/health-prefs", token, { captureEnabled: next, baselineHrBpm: prefs.baselineHrBpm });
      setPrefs(updated);
    } catch {
      Alert.alert("Couldn't save", "Please try again later.");
    } finally {
      setSaving(false);
    }
  };

  const setBaseline = async (val: number | null) => {
    if (!token || !prefs) return;
    setSaving(true);
    try {
      const updated = await putPortal<HrPrefs>("/health-prefs", token, { captureEnabled: prefs.captureEnabled, baselineHrBpm: val });
      setPrefs(updated);
    } catch {
      Alert.alert("Couldn't save", "Please try again later.");
    } finally {
      setSaving(false);
    }
  };

  const wipeAll = () => {
    if (!token) return;
    Alert.alert(
      "Delete all heart-rate data?",
      "This permanently removes every HR sample stored against your account and turns capture off. You can re-enable it later.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deletePortal("/hr-samples", token);
              await reload();
            } catch {
              Alert.alert("Couldn't delete", "Please try again later.");
            }
          },
        },
      ],
    );
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>❤️ Heart-Rate & Stress</Text>
      <Text style={styles.deviceNote}>
        With your permission, KHARAGOLF can record heart-rate and stress samples from your paired watch during a round and tag them to each shot. This helps you spot pressure moments and how your body reacts under tournament conditions.
      </Text>

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12, padding: 12, backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 10 }}>
        <View style={{ flex: 1, paddingRight: 10 }}>
          <Text style={{ color: Colors.text, fontSize: 14, fontWeight: "600" }}>Capture during rounds</Text>
          <Text style={{ color: Colors.muted, fontSize: 11, marginTop: 2 }}>
            Off by default. You can turn this off any time and delete the data below.
          </Text>
        </View>
        <Switch
          value={prefs?.captureEnabled ?? false}
          onValueChange={togglePref}
          disabled={saving || loading || !prefs}
          trackColor={{ false: "#444", true: "#22c55e" }}
        />
      </View>

      <View style={{ marginTop: 12, padding: 12, backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 10 }}>
        <Text style={{ color: Colors.text, fontSize: 13, fontWeight: "600" }}>Resting HR baseline</Text>
        <Text style={{ color: Colors.muted, fontSize: 11, marginTop: 2 }}>
          Used to colour your strips. Leave blank to use a generic scale.
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 8, gap: 8 }}>
          {[55, 60, 65, 70, 75].map(v => (
            <TouchableOpacity
              key={v}
              onPress={() => setBaseline(v)}
              style={{
                paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16,
                borderWidth: 1,
                borderColor: prefs?.baselineHrBpm === v ? Colors.primary : "rgba(255,255,255,0.18)",
                backgroundColor: prefs?.baselineHrBpm === v ? "rgba(201,168,76,0.15)" : "transparent",
              }}
            >
              <Text style={{ color: prefs?.baselineHrBpm === v ? Colors.primary : Colors.text, fontSize: 12, fontWeight: "600" }}>{v}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            onPress={() => setBaseline(null)}
            style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: prefs?.baselineHrBpm == null ? Colors.primary : "rgba(255,255,255,0.18)" }}
          >
            <Text style={{ color: prefs?.baselineHrBpm == null ? Colors.primary : Colors.muted, fontSize: 12 }}>Auto</Text>
          </TouchableOpacity>
        </View>
      </View>

      {loading ? (
        <LoadingSpinner color={Colors.primary} style={{ marginTop: 12 }} />
      ) : prefs?.captureEnabled && latest && latestRound ? (
        <View style={{ marginTop: 12, padding: 12, backgroundColor: "rgba(239,68,68,0.06)", borderRadius: 10, borderWidth: 1, borderColor: "rgba(239,68,68,0.18)" }}>
          <Text style={{ color: "#ef4444", fontSize: 11, fontWeight: "700", marginBottom: 6 }}>
            LAST ROUND HEAT-STRIP · T{latestRound.tournamentId} R{latestRound.round}
          </Text>
          <RoundHrHeatStrip holes={latest.holes} baseline={latest.baselineHrBpm} />
          <Text style={{ color: Colors.muted, fontSize: 10, marginTop: 6 }}>
            Green = relaxed · Yellow/Orange = elevated · Red = high stress (vs your baseline)
          </Text>
        </View>
      ) : prefs?.captureEnabled ? (
        <Text style={[styles.deviceNote, { marginTop: 12, fontStyle: "italic" }]}>
          No HR data yet. Wear your watch on your next round and it will appear here automatically.
        </Text>
      ) : null}

      {corr && corr.delta != null && (
        <View style={{ marginTop: 12, padding: 12, backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 10 }}>
          <Text style={{ color: Colors.text, fontSize: 13, fontWeight: "600", marginBottom: 6 }}>📈 Stress vs scoring</Text>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <View style={{ alignItems: "center", flex: 1 }}>
              <Text style={{ color: "#22c55e", fontSize: 22, fontWeight: "800" }}>
                {corr.hrParOrBetterAvg != null ? Math.round(corr.hrParOrBetterAvg) : "—"}
              </Text>
              <Text style={{ color: Colors.muted, fontSize: 11 }}>par or better</Text>
            </View>
            <View style={{ alignItems: "center", flex: 1 }}>
              <Text style={{ color: "#ef4444", fontSize: 22, fontWeight: "800" }}>
                {corr.hrBogeyOrWorseAvg != null ? Math.round(corr.hrBogeyOrWorseAvg) : "—"}
              </Text>
              <Text style={{ color: Colors.muted, fontSize: 11 }}>bogey or worse</Text>
            </View>
            <View style={{ alignItems: "center", flex: 1 }}>
              <Text style={{ color: corr.delta >= 5 ? "#ef4444" : Colors.text, fontSize: 22, fontWeight: "800" }}>
                {corr.delta >= 0 ? "+" : ""}{Math.round(corr.delta)}
              </Text>
              <Text style={{ color: Colors.muted, fontSize: 11 }}>Δ bpm</Text>
            </View>
          </View>
          <Text style={{ color: Colors.muted, fontSize: 11, marginTop: 8 }}>
            Average HR on holes you bogeyed vs holes you parred or better, across {corr.totalHoles} tracked holes.
          </Text>
        </View>
      )}

      <TouchableOpacity
        style={[styles.deviceBtn, { marginTop: 12, backgroundColor: "rgba(239,68,68,0.10)", borderColor: "rgba(239,68,68,0.4)", borderWidth: 1 }]}
        onPress={wipeAll}
      >
        <Text style={[styles.deviceBtnText, { color: "#ef4444" }]}>🗑️  Delete all heart-rate data</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function StatsScreen() {
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  // Task #2040 — `coaching.gap.closed` push deep-links here with
  // `?focusClub=<clubKey>`. We scroll the Proximity-by-club card into
  // view and briefly highlight the matching club row so the player
  // immediately sees what improved.
  const params = useLocalSearchParams<{ focusClub?: string | string[] }>();
  const focusClub = Array.isArray(params.focusClub) ? params.focusClub[0] : params.focusClub;
  const scrollViewRef = useRef<ScrollView>(null);
  const proxByClubAnchorY = useRef<number>(0);
  const [highlightClubKey, setHighlightClubKey] = useState<string | null>(null);
  const focusClubHandledRef = useRef<string | null>(null);
  const { t } = useTranslation("stats");
  const [tab, setTab] = useState<Tab>("stats");
  const [statsMoreVisible, setStatsMoreVisible] = useState(false);
  const [holeViewSide, setHoleViewSide] = useState<"front" | "back">("front");
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState<StatsPeriod>("allTime");
  const [selectedRound, setSelectedRound] = useState<PlayerStats["recentRounds"][number] | null>(null);
  const [roundDetail, setRoundDetail] = useState<{ player: { firstName: string; lastName: string; handicapIndex: number | null; teeBox: string }; tournament: { name: string; format: string }; organization: { name: string }; courseName: string | null; rounds: { round: number; gross: number; toPar: number; holes: { holeNumber: number; par: number; strokes: number; toPar: number; putts: number | null; fairwayHit: boolean | null; girHit: boolean | null }[]; fairwayPct: number | null; girPct: number | null; totalPutts: number | null }[] } | null>(null);
  const [roundDetailLoading, setRoundDetailLoading] = useState(false);
  const [shareLoading, setShareLoading] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const replayShotRef = useRef<View>(null);

  const {
    data: stats,
    isLoading: statsLoading,
    refetch: refetchStats,
  } = useQuery<PlayerStats>({
    queryKey: ["portal-stats-mobile", period],
    // Task #1643 — no `?baseline=` here on purpose: the server now resolves
    // the SG baseline from the player's pinned preference (mutated below)
    // + their current handicap, so the mobile UI just consumes
    // `strokesGained.preferredBaseline` / `primaryBaseline` / `baselineSource`.
    queryFn: () => fetchPortal<PlayerStats>(`/stats?period=${period}`, token),
    enabled: !!token,
  });

  const sgPrefQueryClient = useQueryClient();
  // Task #1643 — persist the SG baseline pin (auto/scratch/10/18) so the
  // chart remembers it across sessions and devices. Mirrors the proximity
  // mutation pattern at `setProxBaselinePref` below.
  const setSgBaselinePref = useMutation({
    mutationFn: (baseline: SgPickerValue) =>
      putPortal<{ preferredBaseline: SgPickerValue }>("/player/sg-baseline-preference", token, { baseline }),
    onSuccess: () => {
      sgPrefQueryClient.invalidateQueries({ queryKey: ["portal-stats-mobile"] });
    },
  });

  // Task #2048 — Acknowledge a one-time "your benchmark moved" notice. The
  // banner offers two actions: dismiss (no body) and "Pin <previous>"
  // (`{ pin: previousBaseline }`). Both advance `last_seen_auto_sg_baseline`
  // server-side so the same notice doesn't re-fire until the auto-pick
  // crosses *another* threshold.
  const ackSgBaselineChange = useMutation({
    mutationFn: (pin: SGBaseline | null) =>
      postPortal<{ acknowledged: true; preferredBaseline: SgPickerValue; lastSeenAutoSgBaseline: SGBaseline | null }>(
        "/player/sg-baseline-change-ack",
        token,
        pin !== null ? { pin } : {},
      ),
    onSuccess: () => {
      sgPrefQueryClient.invalidateQueries({ queryKey: ["portal-stats-mobile"] });
    },
  });

  // Wellness correlation overlay — buckets rounds by readiness band so the
  // player can see whether full-effort days actually score better.
  type CorrBucket = { rounds: number; avgScore: number; avgSgTotal: number | null };
  type WellnessCorrelation = {
    days: number;
    sampleSize: number;
    buckets: Record<"rest" | "conservative" | "full" | "unknown", CorrBucket>;
    sleepBuckets: Record<"short" | "moderate" | "good" | "unknown", CorrBucket>;
  };
  const { data: wellnessCorrelation } = useQuery<WellnessCorrelation>({
    queryKey: ["wellness-correlation", token],
    queryFn: () => fetchPortal<WellnessCorrelation>("/wellness/correlation?days=60", token),
    enabled: !!token,
  });

  const {
    data: achievements,
    isLoading: achLoading,
    refetch: refetchAch,
  } = useQuery<Achievement[]>({
    queryKey: ["portal-achievements-mobile"],
    queryFn: () => fetchPortal<Achievement[]>("/achievements", token),
    enabled: !!token,
  });

  const {
    data: wearables,
    isLoading: wearablesLoading,
    refetch: refetchWearables,
  } = useQuery<WearableConnection[]>({
    queryKey: ["portal-wearables-mobile"],
    queryFn: () => fetchPortal<WearableConnection[]>("/wearable-connections", token),
    enabled: !!token,
  });

  const { data: clubProfile = [], refetch: refetchClubs } = useQuery<ClubEntry[]>({
    queryKey: ["portal-club-profile-mobile"],
    queryFn: () => fetchPortal<ClubEntry[]>("/club-profile", token),
    enabled: !!token,
  });

  const { data: practiceStats, refetch: refetchPracticeStats } = useQuery<PracticeStats>({
    queryKey: ["portal-practice-stats-mobile"],
    queryFn: () => fetchPortal<PracticeStats>("/practice/stats", token),
    enabled: !!token,
  });

  const { data: practiceSessions = [], refetch: refetchPractice } = useQuery<PracticeSession[]>({
    queryKey: ["portal-practice-sessions-mobile"],
    queryFn: () => fetchPortal<PracticeSession[]>("/practice", token),
    enabled: !!token,
  });

  const { data: prizeAwards = [] } = useQuery<PrizeAward[]>({
    queryKey: ["portal-my-prizes-mobile"],
    queryFn: () => fetchPortal<PrizeAward[]>("/my-prizes", token),
    enabled: !!token,
  });

  const { data: watchStatus, refetch: refetchWatchStatus } = useQuery<{
    appleWatch: { connected: boolean; lastSync: string } | null;
    wearOS: { connected: boolean; lastSync: string } | null;
    garminCiq: { connected: boolean; lastSync: string } | null;
    pairingCode: string | null;
    capabilities: string[];
  }>({
    queryKey: ["portal-watch-status-mobile"],
    queryFn: () => fetchPortal("/watch/status", token),
    enabled: !!token,
    staleTime: 60_000,
  });

  const [generatingCode, setGeneratingCode] = useState(false);
  const [generatedCode, setGeneratedCode] = useState<{ code: string; expiresAt: string } | null>(null);

  const generatePairingCode = async () => {
    if (!token || generatingCode) return;
    setGeneratingCode(true);
    try {
      const result = await fetchPortal<{ code: string; challengeId?: string; expiresAt: string }>("/watch/pairing-code", token);
      setGeneratedCode(result);
      refetchWatchStatus();
      // Push the pairing code + challengeId to the paired watch via WCSession/Data Layer.
      // The watch will include challengeId when calling POST /public/watch/pair, binding the
      // pairing attempt to this specific server challenge row (prevents cross-challenge attacks).
      if (result?.challengeId) {
        try {
          const { WatchBridge } = await import("../../modules/KharagolfWatchBridge");
          await WatchBridge.pushChallenge(result.code, result.challengeId);
        } catch (_) {
          // Native bridge unavailable — user types code manually; challengeId not bound
        }
      }
    } catch (_) {
    } finally {
      setGeneratingCode(false);
    }
  };

  const displayPairingCode = generatedCode?.code ?? watchStatus?.pairingCode ?? null;

  // Task #1641 — `source` / `clubKey` / `practiceDistanceYards` are populated
  // when the form was deep-linked from a "Work on This Club" coaching tip;
  // saving (or cancelling) clears them so the next blank-form open isn't
  // mis-attributed to a tip-driven session.
  const EMPTY_PRACTICE_FORM = {
    sessionType: "range",
    durationMinutes: "",
    notes: "",
    clubFocus: "",
    source: "manual" as "manual" | "coaching_tip",
    clubKey: "",
    practiceDistanceYards: "",
  };
  const [practiceForm, setPracticeForm] = useState(EMPTY_PRACTICE_FORM);
  const [logFormOpen, setLogFormOpen] = useState(false);
  const [loggingPractice, setLoggingPractice] = useState(false);

  // ── Advanced Analytics queries ──────────────────────────────────────────
  const [compareUserId, setCompareUserId] = useState<number | null>(null);
  const [editingClub, setEditingClub] = useState<string | null>(null);
  const [editingCarry, setEditingCarry] = useState("");

  type ProximityStats = { approach: { avgFeet: number; shotCount: number } | null; chip: { avgFeet: number; shotCount: number } | null; sand: { avgFeet: number; shotCount: number } | null; totalShots: number };
  const { data: proximityStats } = useQuery<ProximityStats>({
    queryKey: ["portal-proximity-stats-mobile"],
    queryFn: () => fetchPortal<ProximityStats>("/proximity-stats", token),
    enabled: !!token,
  });

  // Task #1002 — proximity-by-club + weather correlation.
  // Task #1349 — server now also returns the player's auto-derived primary
  // baseline (tour / scratch / mid) plus any pinned override and the source,
  // so the UI can highlight one cohort and let the player switch.
  type ProxPrimaryBaseline = "tour" | "scratch" | "mid";
  type ProxPreferredBaseline = ProxPrimaryBaseline | "auto";
  type ProxBaselineSource = "preference" | "handicap" | "default";
  // Task #1644 — which of the three sources the handicap was actually read
  // from (or null when no handicap is on file). Drives the "Where this comes
  // from" info row beside the baseline picker.
  type ProxHandicapSource = "whs" | "history" | "profile";
  type ProxByClub = {
    clubs: { club: string; shots: number; meanProximityFt: number | null; p90ProximityFt: number | null; greenInRegPct: number | null; benchmark: { clubKey: string; tourMeanFt: number; scratchMeanFt: number; midHandicapMeanFt: number } | null }[];
    handicapIndex?: number | null;
    handicapSource?: ProxHandicapSource | null;
    handicapAsOf?: string | null;
    preferredBaseline?: ProxPreferredBaseline;
    primaryBaseline?: ProxPrimaryBaseline;
    baselineSource?: ProxBaselineSource;
    // Task #1348 — top 1-2 clubs with the largest gap vs tour proximity benchmark.
    // Task #1640 — each tip now also carries a trend annotation vs the prior
    // 30-day window (`trendVsTourFt`, `trendLabel`, `previousMeanProximityFt`).
    // Task #2039 — each tip also carries a 6-bucket weekly gap-vs-tour
    // sparkline (`weeklyGapHistory`) so the trend label gets visual context.
    coachingTips?: {
      club: string;
      clubKey: string;
      shots: number;
      meanProximityFt: number;
      tourMeanFt: number;
      scratchMeanFt: number;
      midHandicapMeanFt: number;
      gapVsTourFt: number;
      gapVsScratchFt: number;
      practiceDistanceYards: number | null;
      aimLongFt: number;
      message: string;
      caddieHint: string;
      previousMeanProximityFt: number | null;
      trendVsTourFt: number | null;
      trendLabel: string | null;
      weeklyGapHistory: {
        weekStart: string;
        shots: number;
        meanProximityFt: number | null;
        gapVsTourFt: number | null;
      }[] | null;
    }[];
  };
  const proxQueryClient = useQueryClient();
  // Task #2041 — let players widen the trend annotation's comparison window
  // (30d / 60d / 90d). Defaults to the legacy 30d behaviour, hydrates from
  // AsyncStorage on mount, and persists every change so the choice survives
  // app restarts. The selected window is threaded into the proximity-by-club
  // query as `?days=` and keyed into the React-Query cache so each window
  // gets its own slot.
  type TrendWindowDays = 30 | 60 | 90;
  const TREND_WINDOW_STORAGE_KEY = "workOnThisClub.trendWindowDays";
  const [trendWindowDays, setTrendWindowDays] = useState<TrendWindowDays>(30);
  const trendWindowHydrated = useRef(false);
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(TREND_WINDOW_STORAGE_KEY)
      .then(raw => {
        if (cancelled) return;
        const parsed = raw ? parseInt(raw, 10) : 30;
        if (parsed === 60 || parsed === 90) setTrendWindowDays(parsed);
      })
      .catch(() => { /* ignore — fall back to default */ })
      .finally(() => { if (!cancelled) trendWindowHydrated.current = true; });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!trendWindowHydrated.current) return;
    AsyncStorage.setItem(TREND_WINDOW_STORAGE_KEY, String(trendWindowDays)).catch(() => {});
  }, [trendWindowDays]);
  const { data: proxByClub } = useQuery<ProxByClub>({
    queryKey: ["portal-proximity-by-club-mobile", trendWindowDays],
    queryFn: () => fetchPortal<ProxByClub>(`/player/proximity-by-club?days=${trendWindowDays}`, token),
    enabled: !!token,
    // Task #2041 — keep the previous tips visible while a new window's
    // request is in flight so the "Work on This Club" card doesn't blink
    // out and back in when the player toggles between 30d / 60d / 90d.
    placeholderData: keepPreviousData,
  });
  const setProxBaselinePref = useMutation({
    mutationFn: (baseline: ProxPreferredBaseline) =>
      putPortal<{ preferredBaseline: ProxPreferredBaseline }>("/player/proximity-baseline-preference", token, { baseline }),
    onSuccess: () => {
      proxQueryClient.invalidateQueries({ queryKey: ["portal-proximity-by-club-mobile"] });
    },
  });

  // Task #2045 — log a "shown" impression once per coaching tip per session.
  //
  // Mirrors the web behaviour in `kharagolf-web/src/pages/stats.tsx`. We
  // dedupe per `clubKey` for the lifetime of this screen mount so a
  // player who pulls-to-refresh, swipes between tabs, or triggers an
  // unrelated re-render doesn't inflate the conversion-rate denominator
  // on the coaching-tip dashboard. The set is held in a ref (not state)
  // so adding to it doesn't itself cause a re-render. Failures are
  // intentionally swallowed: telemetry must never block stats from
  // rendering.
  const loggedTipImpressionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!token) return;
    const tips = proxByClub?.coachingTips ?? [];
    for (const tip of tips) {
      if (loggedTipImpressionsRef.current.has(tip.clubKey)) continue;
      loggedTipImpressionsRef.current.add(tip.clubKey);
      postPortal("/coaching-tip-impression", token, {
        clubKey: tip.clubKey,
        practiceDistanceYards: tip.practiceDistanceYards,
      }).catch(() => {
        // Roll back the dedup entry so we'll retry on the next render
        // if the network blip clears.
        loggedTipImpressionsRef.current.delete(tip.clubKey);
      });
    }
  }, [proxByClub?.coachingTips, token]);
  type WeatherBucketRow = { label: string; min: number; max: number; rounds: number; meanSgTotal: number | null; sgDelta: number | null };
  type WeatherCorr = {
    windowDays: number;
    baselineSgTotal: number | null;
    baselineRoundCount: number;
    windBuckets: WeatherBucketRow[];
    temperatureBuckets: WeatherBucketRow[];
    // Task #1347 — humidity & precipitation buckets join wind & temperature.
    humidityBuckets: WeatherBucketRow[];
    precipitationBuckets: WeatherBucketRow[];
    temperatureAvailable: boolean;
    humidityAvailable: boolean;
    precipitationAvailable: boolean;
  };
  const { data: weatherCorr } = useQuery<WeatherCorr>({
    queryKey: ["portal-weather-correlation-mobile"],
    queryFn: () => fetchPortal<WeatherCorr>("/player/weather-correlation?days=30", token),
    enabled: !!token,
  });

  type ClubGap = { clubs: { club: string; avgCarry: number; manualOverride: boolean; shotCount: number }[]; gaps: { upperClub: string; lowerClub: string; gapYards: number; suggestion: string }[] };
  const { data: clubGapping, refetch: refetchGapping } = useQuery<ClubGap>({
    queryKey: ["portal-club-gapping-mobile"],
    queryFn: () => fetchPortal<ClubGap>("/club-gapping", token),
    enabled: !!token,
  });

  type OrgMember = { userId: number; displayName: string };
  const { data: orgMembers = [] } = useQuery<OrgMember[]>({
    queryKey: ["portal-org-members-mobile"],
    queryFn: () => fetchPortal<OrgMember[]>("/org-members-compare", token),
    enabled: !!token,
  });

  type PlayerCompare = { displayName: string; handicapIndex: number | null; girPct: number | null; fairwayPct: number | null; avgPutts: number | null; scoringAvg: number | null; roundsPlayed: number; sgPutting: number | null; sgApproach: number | null };
  const { data: compareStats, isFetching: compareFetching } = useQuery<{ me: PlayerCompare; them: PlayerCompare }>({
    queryKey: ["portal-compare-mobile", compareUserId],
    queryFn: () => fetchPortal(`/compare/${compareUserId}`, token),
    enabled: !!token && !!compareUserId,
  });

  const saveClubDistance = async (club: string, carry: number) => {
    if (!token) return;
    await fetch(`${BASE_URL}/api/portal/club-distances/${encodeURIComponent(club)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ carryYards: carry }),
    });
    refetchGapping();
    setEditingClub(null);
  };

  const deleteClubOverride = async (club: string) => {
    if (!token) return;
    await fetch(`${BASE_URL}/api/portal/club-distances/${encodeURIComponent(club)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    refetchGapping();
  };
  const [replayMode, setReplayMode] = useState(false);
  const [replayHole, setReplayHole] = useState(0);
  type ShotHoleGroup = { hole: number; shots: { id: number; holeNumber: number | null; shotNumber: number | null; shotType: string | null; distanceToPin: string | null; distanceCarried: string | null; club: string | null; latitude: string | null; longitude: string | null }[] };
  const [replayData, setReplayData] = useState<ShotHoleGroup[]>([]);
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayHr, setReplayHr] = useState<HrRound | null>(null);
  const [stressOnly, setStressOnly] = useState(false);
  const [stressThreshold, setStressThreshold] = useState(15);
  const stressPrefsHydrated = useRef(false);

  // Task #2040 — when the screen mounts (or the deep-link param changes)
  // with `?focusClub=<clubKey>` from the `coaching.gap.closed` push, jump
  // to the stats tab, scroll the Proximity-by-club card into view, and
  // briefly highlight the matching club row. We track the last handled
  // value so re-running the effect on the same param (e.g. Expo Router
  // re-render) doesn't trigger another scroll.
  useEffect(() => {
    if (!focusClub || focusClubHandledRef.current === focusClub) return;
    focusClubHandledRef.current = focusClub;
    setTab("stats");
    setHighlightClubKey(focusClub);
    const scrollTimer = setTimeout(() => {
      try {
        scrollViewRef.current?.scrollTo({ y: Math.max(0, proxByClubAnchorY.current - 16), animated: true });
      } catch {
        // ignore — anchor may not have laid out yet
      }
    }, 350);
    const clearTimer = setTimeout(() => setHighlightClubKey(null), 6000);
    return () => {
      clearTimeout(scrollTimer);
      clearTimeout(clearTimer);
    };
  }, [focusClub]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [onlyRaw, thresholdRaw] = await Promise.all([
          AsyncStorage.getItem("stressReplay.stressOnly"),
          AsyncStorage.getItem("stressReplay.stressThreshold"),
        ]);
        if (cancelled) return;
        if (onlyRaw === "true" || onlyRaw === "false") {
          setStressOnly(onlyRaw === "true");
        }
        if (thresholdRaw != null) {
          const n = parseInt(thresholdRaw, 10);
          if (Number.isFinite(n) && n > 0) setStressThreshold(n);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) stressPrefsHydrated.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!stressPrefsHydrated.current) return;
    AsyncStorage.setItem("stressReplay.stressOnly", stressOnly ? "true" : "false").catch(() => {});
  }, [stressOnly]);

  useEffect(() => {
    if (!stressPrefsHydrated.current) return;
    AsyncStorage.setItem("stressReplay.stressThreshold", String(stressThreshold)).catch(() => {});
  }, [stressThreshold]);

  const BASE_URL = process.env.EXPO_PUBLIC_DOMAIN ? `https://${process.env.EXPO_PUBLIC_DOMAIN}` : "";

  const fetchReplay = async (r: NonNullable<typeof selectedRound>) => {
    setReplayLoading(true);
    setReplayData([]);
    setReplayHr(null);
    const shotsPromise = fetch(`${BASE_URL}/api/portal/rounds/${r.round}/shots?tournamentId=${r.tournamentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(async res => {
      if (!res.ok) throw new Error("Failed");
      return res.json();
    });
    const hrPromise = token
      ? fetchPortal<HrRound>(`/hr-samples/round?tournamentId=${r.tournamentId}&round=${r.round}`, token).catch(() => null)
      : Promise.resolve(null);
    const [shotsRes, hrRes] = await Promise.allSettled([shotsPromise, hrPromise]);
    if (shotsRes.status === "fulfilled") {
      const data = shotsRes.value;
      setReplayData(Array.isArray(data) ? data : []);
      setReplayHole(0);
    } else {
      setReplayData([]);
    }
    if (hrRes.status === "fulfilled") setReplayHr(hrRes.value);
    setReplayLoading(false);
  };

  const logPractice = async () => {
    if (!token) return;
    setLoggingPractice(true);
    try {
      const res = await fetch(`${BASE_URL}/api/portal/practice`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionType: practiceForm.sessionType,
          notes: practiceForm.notes,
          clubFocus: practiceForm.clubFocus,
          durationMinutes: practiceForm.durationMinutes ? parseInt(practiceForm.durationMinutes) : null,
          // Task #1641 — only forward the coaching-tip metadata when the form
          // was actually deep-linked from a tip; manual entries leave them
          // null so the cohort split stays clean.
          source: practiceForm.source,
          clubKey: practiceForm.source === "coaching_tip" && practiceForm.clubKey ? practiceForm.clubKey : null,
          practiceDistanceYards:
            practiceForm.source === "coaching_tip" && practiceForm.practiceDistanceYards
              ? parseInt(practiceForm.practiceDistanceYards)
              : null,
        }),
      });
      if (!res.ok) throw new Error("Failed");
      await Promise.all([refetchPractice(), refetchPracticeStats()]);
      setLogFormOpen(false);
      setPracticeForm(EMPTY_PRACTICE_FORM);
      Alert.alert("✓ Logged", "Practice session saved!");
    } catch {
      Alert.alert("Error", "Failed to log practice session.");
    } finally {
      setLoggingPractice(false);
    }
  };

  // Task #1641 — invoked from the "Log practice" CTA on a "Work on This Club"
  // coaching tip. Switches to the Practice tab, opens the log form and
  // pre-fills it with the tip's club + suggested distance band so the player
  // only has to tap "Save Session".
  const startPracticeFromTip = (req: { club: string; clubKey: string; practiceDistanceYards: number | null }) => {
    setPracticeForm({
      sessionType: "range",
      durationMinutes: "",
      notes: req.practiceDistanceYards !== null
        ? `From coaching tip: practice your ${req.club} from ${req.practiceDistanceYards} yds.`
        : `From coaching tip: practice your ${req.club}.`,
      clubFocus: req.club,
      source: "coaching_tip",
      clubKey: req.clubKey,
      practiceDistanceYards: req.practiceDistanceYards !== null ? String(req.practiceDistanceYards) : "",
    });
    setLogFormOpen(true);
    setTab("practice");
  };

  const deletePractice = async (id: number) => {
    if (!token) return;
    Alert.alert("Delete session?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: async () => {
          await fetch(`${BASE_URL}/api/portal/practice/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
          await Promise.all([refetchPractice(), refetchPracticeStats()]);
        },
      },
    ]);
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await Promise.all([refetchStats(), refetchAch(), refetchWearables(), refetchClubs(), refetchPractice(), refetchPracticeStats()]);
    setRefreshing(false);
  };

  const totalHoles = (stats?.eagles ?? 0) + (stats?.birdies ?? 0) + (stats?.pars ?? 0) + (stats?.bogeys ?? 0) + (stats?.doublePlus ?? 0);

  function ScoringBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
    const pct = total > 0 ? value / total : 0;
    return (
      <View style={styles.barRow}>
        <Text style={styles.barLabel}>{label}</Text>
        <View style={styles.barTrack}>
          <View style={[styles.barFill, { width: `${Math.round(pct * 100)}%`, backgroundColor: color }]} />
        </View>
        <Text style={styles.barCount}>{value}</Text>
      </View>
    );
  }

  function StatCard({ icon, label, value, color }: { icon: string; label: string; value: string | number; color: string }) {
    return (
      <View style={styles.statCard}>
        <Text style={{ fontSize: 22 }}>{icon}</Text>
        <Text style={[styles.statValue, { color }]}>{value}</Text>
        <Text style={styles.statLabel}>{label}</Text>
      </View>
    );
  }

  async function openRoundViewer(r: PlayerStats["recentRounds"][number]) {
    setSelectedRound(r);
    setRoundDetail(null);
    setRoundDetailLoading(true);
    fetchReplay(r);
    try {
      const res = await fetch(`/api/portal/tournament-player/${r.playerId}/scorecard/share`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Could not load scorecard");
      const { shareToken } = await res.json();
      const detail = await fetch(`/api/public/scorecard/${shareToken}`).then(r2 => r2.json());
      setRoundDetail(detail);
    } catch {
      setRoundDetail(null);
    } finally {
      setRoundDetailLoading(false);
    }
  }

  async function persistReplayImageToLibrary(uri: string): Promise<boolean> {
    let perm = await MediaLibrary.getPermissionsAsync();
    if (perm.status !== "granted") {
      if (!perm.canAskAgain) {
        Alert.alert(
          "Photo access needed",
          "KHARAGOLF can't save the replay image because photo library access is turned off. You can enable it in Settings.",
          [{ text: "Cancel", style: "cancel" }, { text: "Open Settings", onPress: () => Linking.openSettings() }],
        );
        return false;
      }
      perm = await MediaLibrary.requestPermissionsAsync();
    }
    if (perm.status !== "granted") {
      Alert.alert("Permission denied", "We need access to your photo library to save the replay image.");
      return false;
    }
    await MediaLibrary.saveToLibraryAsync(uri);
    return true;
  }

  async function saveReplayImage() {
    if (!replayMode || !replayData[replayHole] || !replayShotRef.current) return;
    setSaveLoading(true);
    try {
      const uri = await captureRef(replayShotRef, { format: "png", quality: 1, result: "tmpfile" });
      const ok = await persistReplayImageToLibrary(uri);
      if (ok) Alert.alert("Saved", "Replay image saved to your photo library.");
    } catch {
      Alert.alert("Error", "Could not save the replay image.");
    } finally {
      setSaveLoading(false);
    }
  }

  async function shareRound() {
    if (!selectedRound) return;
    setShareLoading(true);
    try {
      if (replayMode && replayData[replayHole] && replayShotRef.current) {
        const hole = replayData[replayHole].hole;
        const baseline = replayHr?.baselineHrBpm ?? null;
        const baselineText = baseline != null
          ? `HR baseline: ${baseline} bpm — colors show beats above/below baseline.`
          : "HR baseline not set — set one in Health & Stress for context.";
        const message = `My Hole ${hole} shot replay with heart-rate badges. ${baselineText}`;
        const uri = await captureRef(replayShotRef, { format: "png", quality: 1, result: "tmpfile" });
        const runShare = async () => {
          try {
            const canShare = await Sharing.isAvailableAsync();
            if (canShare) {
              await Sharing.shareAsync(uri, { mimeType: "image/png", dialogTitle: "Share Shot Replay" });
            } else {
              await Share.share({ message, url: uri });
            }
          } catch {
            Alert.alert("Error", "Could not share the replay image.");
          }
        };
        const runSave = async () => {
          try {
            const ok = await persistReplayImageToLibrary(uri);
            if (ok) Alert.alert("Saved", "Replay image saved to your photo library.");
          } catch {
            Alert.alert("Error", "Could not save the replay image.");
          }
        };
        Alert.alert(
          "Share Shot Replay",
          "Save the replay image to your photos or share it with someone.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Save to Photos", onPress: () => { void runSave(); } },
            { text: "Share…", onPress: () => { void runShare(); } },
          ],
        );
        return;
      }
      const res = await fetch(`/api/portal/tournament-player/${selectedRound.playerId}/scorecard/share`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed");
      const { shareUrl } = await res.json();
      await Share.share({ message: `Check out my scorecard: ${shareUrl}`, url: shareUrl });
    } catch {
      Alert.alert("Error", replayMode ? "Could not share replay image." : "Could not generate share link.");
    } finally {
      setShareLoading(false);
    }
  }

  function toParColor(tp: number): string {
    if (tp <= -2) return "#d97706";
    if (tp === -1) return "#dc2626";
    if (tp === 0) return Colors.text;
    if (tp === 1) return "#2563eb";
    return "#7c3aed";
  }

  function toParBg(tp: number): string {
    if (tp <= -2) return "rgba(217,119,6,0.2)";
    if (tp === -1) return "rgba(220,38,38,0.2)";
    if (tp === 0) return "rgba(255,255,255,0.07)";
    if (tp === 1) return "rgba(37,99,235,0.2)";
    return "rgba(124,58,237,0.2)";
  }

  function RoundBar({ round, toPar }: { round: number; toPar: number }) {
    const capped = Math.max(-5, Math.min(toPar, 10));
    const pct = (capped + 5) / 15;
    const barColor = toPar < 0 ? Colors.primary : toPar === 0 ? "#3b82f6" : toPar <= 2 ? "#f97316" : "#ef4444";
    return (
      <View style={styles.roundBar}>
        <Text style={styles.roundBarLabel}>R{round}</Text>
        <View style={styles.roundBarTrack}>
          <View style={[styles.roundBarFill, { width: `${Math.round(pct * 100)}%`, backgroundColor: barColor }]} />
        </View>
        <Text style={[styles.roundBarValue, { color: barColor }]}>
          {toPar === 0 ? "E" : toPar > 0 ? `+${toPar}` : `${toPar}`}
        </Text>
      </View>
    );
  }

  const isLoading = statsLoading || achLoading;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Analytics</Text>
        <Text style={styles.headerSub}>Stats, achievements & device connections</Text>
      </View>

      {/* Tab bar — 5 fixed equal-width slots, no horizontal scroll */}
      <View style={styles.tabsBar}>
        {([
          ["stats", "Stats"],
          ["clubs", "Clubs"],
          ["practice", "Practice"],
          ["achievements", "Badges"],
        ] as [Tab, string][]).map(([t, label]) => (
          <TouchableOpacity
            key={t}
            style={[styles.tabBtn, tab === t && styles.tabBtnActive]}
            onPress={() => setTab(t)}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
        {/* More button — covers Prizes, Devices, HCP Calc */}
        <TouchableOpacity
          style={[styles.tabBtn, (tab === "prizes" || tab === "devices" || tab === "handicap" || tab === "compare") && styles.tabBtnActive]}
          onPress={() => setStatsMoreVisible(true)}
        >
          <Text style={[styles.tabText, (tab === "prizes" || tab === "devices" || tab === "handicap" || tab === "compare") && styles.tabTextActive]}>
            {tab === "prizes" ? "Prizes" : tab === "devices" ? "Devices" : tab === "handicap" ? "HCP" : tab === "compare" ? "Compare" : "More"}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Stats "More" picker modal */}
      <Modal visible={statsMoreVisible} transparent animationType="slide" onRequestClose={() => setStatsMoreVisible(false)}>
        <Pressable style={styles.moreBackdrop} onPress={() => setStatsMoreVisible(false)}>
          <Pressable style={styles.moreSheet} onPress={e => e.stopPropagation()}>
            <View style={styles.modalHandle} />
            <Text style={styles.moreSheetTitle}>More</Text>
            {([
              ["prizes", "🏆", "Prizes", "Winnings & trophies"],
              ["compare", "⚔️", "Compare", "Head-to-head vs club members"],
              ["devices", "⌚", "Devices", "Garmin, Apple Watch & GPS"],
              ["handicap", "🧮", "HCP Calculator", "World Handicap System simulator"],
            ] as [Tab, string, string, string][]).map(([t, icon, label, desc]) => (
              <Pressable key={t} style={[styles.moreItem, tab === t && styles.moreItemActive]} onPress={() => { setTab(t); setStatsMoreVisible(false); }}>
                <Text style={{ fontSize: 24 }}>{icon}</Text>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={[styles.moreItemLabel, tab === t && { color: Colors.primary }]}>{label}</Text>
                  <Text style={styles.moreItemDesc}>{desc}</Text>
                </View>
                {tab === t && <Ionicons name="checkmark-circle" size={20} color={Colors.primary} />}
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      {isLoading ? (
        <LoadingSpinner color={Colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <ScrollView
          ref={scrollViewRef}
          style={styles.scroll}
          contentContainerStyle={{ paddingBottom: insets.bottom + 100 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
          showsVerticalScrollIndicator={false}
        >
          {tab === "stats" ? (
            <>
              {/* Period filter chips */}
              <View style={styles.periodRow}>
                {([["allTime", "All Time"], ["thisYear", "This Year"], ["last5rounds", "Last 5"], ["last10rounds", "Last 10"], ["last20rounds", "Last 20"]] as [StatsPeriod, string][]).map(([p, label]) => (
                  <TouchableOpacity
                    key={p}
                    onPress={() => setPeriod(p)}
                    style={[styles.periodChip, period === p && styles.periodChipActive]}
                  >
                    <Text style={[styles.periodChipText, period === p && styles.periodChipTextActive]}>{label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {!stats || stats.roundsPlayed === 0 ? (
                <View style={styles.empty}>
                  <Text style={{ fontSize: 40 }}>⛳</Text>
                  <Text style={styles.emptyTitle}>No rounds yet</Text>
                  <Text style={styles.emptyText}>Play your first tournament to see your statistics here.</Text>
                </View>
              ) : (
                <>
                  {/* Summary Cards */}
                  <View style={styles.statGrid}>
                    <StatCard icon="🏌️" label="Rounds" value={stats.roundsPlayed} color="#22c55e" />
                    <StatCard icon="🎯" label="Avg Score" value={stats.scoringAvg?.toFixed(1) ?? "—"} color="#3b82f6" />
                    <StatCard icon="⭐" label="Best Round" value={stats.bestRound ?? "—"} color="#22c55e" />
                    <StatCard icon="📉" label="Worst Round" value={stats.worstRound ?? "—"} color="#f97316" />
                  </View>

                  {/* Wellness correlation — score & SG-total averages by
                      readiness AND by sleep band. Hidden until we have at
                      least 3 rounds tagged with wellness data. */}
                  {wellnessCorrelation && wellnessCorrelation.sampleSize >= 3 && (
                    <View style={styles.section}>
                      <Text style={styles.sectionTitle}>Score & SG by Readiness</Text>
                      <Text style={{ color: Colors.tabIconDefault, fontSize: 12, marginBottom: 8 }}>
                        Last {wellnessCorrelation.days} days · {wellnessCorrelation.sampleSize} round(s) tagged with wellness data
                      </Text>
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        {(["full", "conservative", "rest", "unknown"] as const).map(level => {
                          const b = wellnessCorrelation.buckets[level];
                          const labels = { full: "Full", conservative: "Cons.", rest: "Rest", unknown: "—" } as const;
                          const colors = { full: "#22c55e", conservative: "#f59e0b", rest: "#ef4444", unknown: Colors.border } as const;
                          return (
                            <View key={level} style={{ flex: 1, padding: 10, borderRadius: 10, backgroundColor: colors[level] + "22", borderWidth: 1, borderColor: colors[level] + "55" }}>
                              <Text style={{ color: colors[level], fontSize: 11, fontWeight: "700", letterSpacing: 1 }}>{labels[level].toUpperCase()}</Text>
                              <Text style={{ color: "#fff", fontSize: 22, fontWeight: "700", marginTop: 4 }}>
                                {b.rounds > 0 ? b.avgScore.toFixed(1) : "—"}
                              </Text>
                              <Text style={{ color: Colors.tabIconDefault, fontSize: 11, marginTop: 2 }}>
                                {b.avgSgTotal != null ? `SG ${b.avgSgTotal > 0 ? "+" : ""}${b.avgSgTotal.toFixed(1)}` : `${b.rounds} rd`}
                              </Text>
                            </View>
                          );
                        })}
                      </View>

                      <Text style={[styles.sectionTitle, { marginTop: 16, fontSize: 14 }]}>Score & SG by Sleep</Text>
                      <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
                        {(["good", "moderate", "short", "unknown"] as const).map(level => {
                          const b = wellnessCorrelation.sleepBuckets[level];
                          const labels = { good: "≥7.5h", moderate: "6–7.5h", short: "<6h", unknown: "—" } as const;
                          const colors = { good: "#22c55e", moderate: "#f59e0b", short: "#ef4444", unknown: Colors.border } as const;
                          return (
                            <View key={level} style={{ flex: 1, padding: 10, borderRadius: 10, backgroundColor: colors[level] + "22", borderWidth: 1, borderColor: colors[level] + "55" }}>
                              <Text style={{ color: colors[level], fontSize: 11, fontWeight: "700", letterSpacing: 1 }}>{labels[level]}</Text>
                              <Text style={{ color: "#fff", fontSize: 22, fontWeight: "700", marginTop: 4 }}>
                                {b.rounds > 0 ? b.avgScore.toFixed(1) : "—"}
                              </Text>
                              <Text style={{ color: Colors.tabIconDefault, fontSize: 11, marginTop: 2 }}>
                                {b.avgSgTotal != null ? `SG ${b.avgSgTotal > 0 ? "+" : ""}${b.avgSgTotal.toFixed(1)}` : `${b.rounds} rd`}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    </View>
                  )}

                  {/* Approach stats */}
                  <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Approach Statistics</Text>
                    <View style={styles.row3}>
                      <View style={styles.approach}>
                        <Text style={styles.approachVal}>{stats.fairwayPct !== null ? `${stats.fairwayPct}%` : "—"}</Text>
                        <Text style={styles.approachLabel}>Fairways</Text>
                      </View>
                      <View style={[styles.approach, styles.approachBorder]}>
                        <Text style={styles.approachVal}>{stats.girPct !== null ? `${stats.girPct}%` : "—"}</Text>
                        <Text style={styles.approachLabel}>GIR</Text>
                      </View>
                      <View style={styles.approach}>
                        <Text style={styles.approachVal}>{stats.avgPutts !== null ? stats.avgPutts : "—"}</Text>
                        <Text style={styles.approachLabel}>Avg Putts</Text>
                      </View>
                    </View>
                    {/* Short game row */}
                    <View style={[styles.row3, { marginTop: 12, borderTopWidth: 1, borderColor: "rgba(255,255,255,0.08)", paddingTop: 12 }]}>
                      <View style={styles.approach}>
                        <Text style={styles.approachVal}>{stats.shortGame?.sandSavePct !== null && stats.shortGame?.sandSavePct !== undefined ? `${stats.shortGame.sandSavePct}%` : "—"}</Text>
                        <Text style={styles.approachLabel}>Sand Save</Text>
                      </View>
                      <View style={[styles.approach, styles.approachBorder]}>
                        <Text style={styles.approachVal}>{stats.shortGame?.upAndDownPct !== null && stats.shortGame?.upAndDownPct !== undefined ? `${stats.shortGame.upAndDownPct}%` : "—"}</Text>
                        <Text style={styles.approachLabel}>Up & Down</Text>
                      </View>
                      <View style={styles.approach} />
                    </View>
                  </View>

                  {/* Putting */}
                  {stats.putting && stats.putting.holesTracked > 0 && (
                    <View style={styles.section}>
                      <Text style={styles.sectionTitle}>🎯 Putting</Text>
                      <View style={styles.row3}>
                        <View style={styles.approach}>
                          <Text style={styles.approachVal}>{stats.avgPutts !== null ? stats.avgPutts.toFixed(2) : "—"}</Text>
                          <Text style={styles.approachLabel}>Avg / Hole</Text>
                        </View>
                        <View style={[styles.approach, styles.approachBorder]}>
                          <Text style={[styles.approachVal, { color: "#22c55e" }]}>{stats.putting.onePutts}</Text>
                          <Text style={styles.approachLabel}>1‑Putts {stats.putting.onePuttPct !== null ? `(${stats.putting.onePuttPct}%)` : ""}</Text>
                        </View>
                        <View style={styles.approach}>
                          <Text style={[styles.approachVal, { color: "#ef4444" }]}>{stats.putting.threePlusPutts}</Text>
                          <Text style={styles.approachLabel}>3+ Putts {stats.putting.threePlusPuttPct !== null ? `(${stats.putting.threePlusPuttPct}%)` : ""}</Text>
                        </View>
                      </View>
                      {(() => {
                        const pts = stats.recentRounds.filter(r => r.avgPutts !== null) as { round: number; avgPutts: number }[];
                        if (pts.length < 2) {
                          return (
                            <Text style={styles.sgNote}>{stats.putting.holesTracked} holes tracked · record putts to see your trend.</Text>
                          );
                        }
                        const W = 320, H = 90, PAD = { l: 28, r: 8, t: 10, b: 18 };
                        const vals = pts.map(p => p.avgPutts!);
                        const minV = Math.min(...vals);
                        const maxV = Math.max(...vals);
                        const range = (maxV - minV) || 0.5;
                        const coords = pts.map((p, i) => {
                          const x = PAD.l + (i / Math.max(pts.length - 1, 1)) * (W - PAD.l - PAD.r);
                          const y = PAD.t + ((maxV - p.avgPutts!) / range) * (H - PAD.t - PAD.b);
                          return { x, y, val: p.avgPutts! };
                        });
                        const poly = coords.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
                        const last = coords[coords.length - 1];
                        return (
                          <View style={{ marginTop: 10 }}>
                            <Text style={[styles.approachLabel, { marginBottom: 4 }]}>Putts per Round (avg / hole)</Text>
                            <Svg width={W} height={H + 4}>
                              <SvgLine x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={H - PAD.b + 4} stroke="rgba(255,255,255,0.1)" strokeWidth={1} />
                              <SvgLine x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} stroke="rgba(255,255,255,0.1)" strokeWidth={1} />
                              <SvgText x={PAD.l - 4} y={PAD.t + 4} fontSize={9} fill="rgba(255,255,255,0.4)" textAnchor="end">{maxV.toFixed(2)}</SvgText>
                              <SvgText x={PAD.l - 4} y={H - PAD.b} fontSize={9} fill="rgba(255,255,255,0.4)" textAnchor="end">{minV.toFixed(2)}</SvgText>
                              <Polyline points={poly} fill="none" stroke="#3b82f6" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                              {coords.map((c, i) => (
                                <Circle key={i} cx={c.x} cy={c.y} r={i === coords.length - 1 ? 4 : 2.5} fill={i === coords.length - 1 ? "#3b82f6" : "#0a1a0f"} stroke="#3b82f6" strokeWidth={1.5} />
                              ))}
                              <SvgText x={last.x} y={Math.max(last.y - 6, PAD.t + 4)} fontSize={9} fill="#3b82f6" textAnchor="middle" fontWeight="700">{last.val.toFixed(2)}</SvgText>
                            </Svg>
                          </View>
                        );
                      })()}
                    </View>
                  )}

                  {/* Event Breakdown */}
                  {stats.eventBreakdown && stats.eventBreakdown.generalPlayRounds > 0 && (
                    <View style={styles.section}>
                      <Text style={styles.sectionTitle}>🏆 Tournament vs Casual Play</Text>
                      <View style={styles.row3}>
                        <View style={styles.approach}>
                          <Text style={[styles.approachVal, { color: "#C9A84C" }]}>{stats.eventBreakdown.tournamentRounds}</Text>
                          <Text style={styles.approachLabel}>Tournament</Text>
                          {stats.eventBreakdown.tournamentScoringAvg !== null && (
                            <Text style={[styles.approachLabel, { fontSize: 10, marginTop: 2 }]}>Avg {stats.eventBreakdown.tournamentScoringAvg}</Text>
                          )}
                        </View>
                        <View style={[styles.approach, styles.approachBorder]}>
                          <Text style={[styles.approachVal, { color: "#3b82f6" }]}>{stats.eventBreakdown.generalPlayRounds}</Text>
                          <Text style={styles.approachLabel}>Casual</Text>
                          {stats.eventBreakdown.generalPlayScoringAvg !== null && (
                            <Text style={[styles.approachLabel, { fontSize: 10, marginTop: 2 }]}>Avg {stats.eventBreakdown.generalPlayScoringAvg}</Text>
                          )}
                        </View>
                        <View style={styles.approach}>
                          <Text style={[styles.approachVal, { color: "#22c55e" }]}>{stats.roundsPlayed}</Text>
                          <Text style={styles.approachLabel}>Total</Text>
                        </View>
                      </View>
                    </View>
                  )}

                  {/* Handicap Trend */}
                  {(stats.handicapTrend ?? []).length >= 2 && (
                    <View style={styles.section}>
                      <Text style={styles.sectionTitle}>Handicap Trend</Text>
                      <HandicapChart data={stats.handicapTrend!} committeeAdjustments={stats.committeeAdjustments ?? []} />
                    </View>
                  )}

                  {/* Task #2048 — One-time "your benchmark moved" notice
                       when the auto-derived SG cohort has crossed a
                       threshold since the player's last visit. Renders
                       above the SG card so the player sees it before
                       reading the (now-different) numbers. */}
                  {stats.strokesGained?.baselineChange && (() => {
                    const change = stats.strokesGained!.baselineChange!;
                    const labelOf = (b: SGBaseline) =>
                      b === "scratch" ? "Tour/Scratch" : b === "10" ? "10-handicap" : "18-handicap";
                    const previous = labelOf(change.previousBaseline);
                    const current = labelOf(change.currentBaseline);
                    return (
                      <View
                        testID="sg-baseline-change-banner"
                        style={{
                          marginHorizontal: 12,
                          marginTop: 8,
                          padding: 12,
                          borderRadius: 10,
                          borderWidth: 1,
                          borderColor: "rgba(201,168,76,0.4)",
                          backgroundColor: "rgba(201,168,76,0.08)",
                        }}
                      >
                        <Text style={{ color: Colors.text, fontWeight: "700", fontSize: 13, marginBottom: 4 }}>
                          ⚡ Your benchmark moved to {current}
                        </Text>
                        <Text style={{ color: Colors.muted, fontSize: 12, marginBottom: 10 }}>
                          Your strokes-gained comparison auto-updated as your handicap changed. Pin {previous} if you'd rather keep comparing against your previous benchmark.
                        </Text>
                        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                          <Pressable
                            testID="sg-baseline-change-pin"
                            onPress={() => ackSgBaselineChange.mutate(change.previousBaseline)}
                            disabled={ackSgBaselineChange.isPending}
                            accessibilityRole="button"
                            accessibilityLabel={`Pin ${previous} as my strokes-gained baseline`}
                            style={{
                              paddingHorizontal: 12,
                              paddingVertical: 6,
                              borderRadius: 14,
                              backgroundColor: "rgba(201,168,76,0.2)",
                              borderWidth: 1,
                              borderColor: "rgba(201,168,76,0.5)",
                              opacity: ackSgBaselineChange.isPending ? 0.6 : 1,
                            }}
                          >
                            <Text style={{ color: Colors.primary, fontSize: 12, fontWeight: "600" }}>
                              Pin {previous}
                            </Text>
                          </Pressable>
                          <Pressable
                            testID="sg-baseline-change-dismiss"
                            onPress={() => ackSgBaselineChange.mutate(null)}
                            disabled={ackSgBaselineChange.isPending}
                            accessibilityRole="button"
                            accessibilityLabel="Dismiss strokes-gained baseline change notice"
                            style={{
                              paddingHorizontal: 12,
                              paddingVertical: 6,
                              borderRadius: 14,
                              borderWidth: 1,
                              borderColor: "rgba(255,255,255,0.18)",
                              opacity: ackSgBaselineChange.isPending ? 0.6 : 1,
                            }}
                          >
                            <Text style={{ color: Colors.text, fontSize: 12, fontWeight: "600" }}>
                              Got it
                            </Text>
                          </Pressable>
                        </View>
                      </View>
                    );
                  })()}

                  {/* Strokes Gained */}
                  {stats.strokesGained && stats.strokesGained.trackedRounds >= 5 ? (
                    <View style={styles.section}>
                      <Text style={styles.sectionTitle}>
                        ⚡ Strokes Gained vs {stats.strokesGained.baseline === "scratch" ? "Tour" : `${stats.strokesGained.baseline}-hcp`}
                      </Text>
                      {/* Task #1643 — SG baseline picker (auto + 3 cohorts).
                          Mirrors the proximity-by-club picker pattern, with
                          a one-line caption below explaining *why* the
                          current baseline was chosen. */}
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
                        {(() => {
                          const sgMeta = stats.strokesGained!;
                          const current: SgPickerValue = sgMeta.preferredBaseline ?? "auto";
                          return ([["auto", "Auto"], ["scratch", "Tour/Scratch"], ["10", "10 Hcp"], ["18", "18 Hcp"]] as [SgPickerValue, string][]).map(([opt, label]) => (
                            <Pressable
                              key={opt}
                              onPress={() => setSgBaselinePref.mutate(opt)}
                              disabled={setSgBaselinePref.isPending}
                              accessibilityRole="button"
                              accessibilityLabel={`Set strokes-gained baseline to ${label}`}
                              accessibilityState={{ selected: current === opt }}
                              testID={`sg-baseline-${opt}`}
                              style={{
                                paddingHorizontal: 10,
                                paddingVertical: 5,
                                borderRadius: 14,
                                borderWidth: 1,
                                borderColor: current === opt ? Colors.primary : "rgba(255,255,255,0.18)",
                                backgroundColor: current === opt ? "rgba(201,168,76,0.15)" : "transparent",
                                opacity: setSgBaselinePref.isPending ? 0.6 : 1,
                              }}
                            >
                              <Text style={{ color: current === opt ? Colors.primary : Colors.text, fontSize: 11, fontWeight: "600" }}>
                                {label}
                              </Text>
                            </Pressable>
                          ));
                        })()}
                      </View>
                      {(() => {
                        const sgMeta = stats.strokesGained!;
                        if (!sgMeta.primaryBaseline) return null;
                        const labelOf = (b: SGBaseline) =>
                          b === "scratch" ? "Tour/Scratch" : b === "10" ? "10-hcp" : "18-hcp";
                        const primary = labelOf(sgMeta.primaryBaseline);
                        let copy: string;
                        if (sgMeta.baselineSource === "preference") {
                          copy = `Pinned to ${primary}`;
                        } else if (sgMeta.baselineSource === "handicap" && sgMeta.handicapIndex != null) {
                          copy = `Auto-picked from your ${sgMeta.handicapIndex.toFixed(1)} handicap → ${primary}`;
                        } else {
                          copy = `Defaulting to ${primary} (no handicap on file yet)`;
                        }
                        return (
                          <Text testID="sg-baseline-source-copy" style={[styles.sgNote, { fontStyle: "italic", marginBottom: 6 }]}>
                            {copy}
                          </Text>
                        );
                      })()}
                      <View style={styles.row4}>
                        {[
                          { label: "Putting", value: stats.strokesGained.sgPutting },
                          { label: "Approach", value: stats.strokesGained.sgApproach },
                          { label: "ATG", value: stats.strokesGained.sgATG },
                          { label: "OTT", value: stats.strokesGained.sgOffTheTee },
                          { label: "Total", value: stats.strokesGained.sgTotal },
                        ].map(sg => (
                          <View key={sg.label} style={styles.sgCell}>
                            <Text style={[styles.sgVal, sg.value !== null && sg.value >= 0 ? styles.sgPos : styles.sgNeg]}>
                              {sg.value !== null ? `${sg.value >= 0 ? "+" : ""}${sg.value.toFixed(2)}` : "—"}
                            </Text>
                            <Text style={styles.approachLabel}>{sg.label}</Text>
                          </View>
                        ))}
                      </View>
                      <Text style={styles.sgNote}>{stats.strokesGained.trackedRounds} rounds tracked · positive = above baseline</Text>
                      {(stats.strokesGained.sgPuttingMeasuredRounds !== undefined || stats.strokesGained.sgPuttingEstimatedRounds !== undefined) && (
                        (stats.strokesGained.sgPuttingMeasuredRounds ?? 0) + (stats.strokesGained.sgPuttingEstimatedRounds ?? 0) > 0 ? (
                          <Text style={styles.sgNote}>
                            SG-Putting split: {stats.strokesGained.sgPuttingMeasuredRounds ?? 0} measured · {stats.strokesGained.sgPuttingEstimatedRounds ?? 0} estimated
                          </Text>
                        ) : null
                      )}
                      <Text style={styles.sgNote}>
                        SG-Putting is measured from per-shot tracking on the green when available. For rounds without per-shot putt data, it's estimated from your scorecard putt count against the tour-average first-putt baseline (~33 ft) — these holes are marked with a "~" on the scoring screen.
                      </Text>
                    </View>
                  ) : stats.strokesGained && stats.strokesGained.trackedRounds > 0 ? (
                    <View style={styles.section}>
                      <Text style={styles.sectionTitle}>⚡ Strokes Gained</Text>
                      <Text style={styles.sgNote}>{stats.strokesGained.trackedRounds}/5 rounds tracked. Record putts, GIR & fairways to unlock SG analysis (Putting, Approach, ATG, OTT).</Text>
                    </View>
                  ) : null}

                  {/* Score Distribution */}
                  <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Score Distribution</Text>
                    <ScoringBar label="🦅 Eagles" value={stats.eagles} total={totalHoles} color="#f59e0b" />
                    <ScoringBar label="🐦 Birdies" value={stats.birdies} total={totalHoles} color="#22c55e" />
                    <ScoringBar label="◼ Pars" value={stats.pars} total={totalHoles} color="#3b82f6" />
                    <ScoringBar label="Bogeys" value={stats.bogeys} total={totalHoles} color="#f97316" />
                    <ScoringBar label="Dbl+" value={stats.doublePlus} total={totalHoles} color="#ef4444" />
                  </View>

                  {/* Recent Rounds */}
                  {stats.recentRounds.length > 0 && (
                    <View style={styles.section}>
                      <Text style={styles.sectionTitle}>Recent Rounds</Text>
                      {stats.recentRounds.slice(0, 8).map((r, i) => (
                        <Pressable key={i} onPress={() => openRoundViewer(r)} style={({ pressed }) => [{ opacity: pressed ? 0.8 : 1 }]}>
                          <RoundBar round={r.round} toPar={r.toPar} />
                        </Pressable>
                      ))}
                    </View>
                  )}

                  {/* Course Breakdown — full-width vertical list, no horizontal scroll */}
                  {(stats.courseBreakdown ?? []).length > 0 && (
                    <View style={styles.section}>
                      <Text style={styles.sectionTitle}>Course Performance</Text>
                      <View style={{ gap: 8 }}>
                        {stats.courseBreakdown!.map((c) => (
                          <View key={c.courseId} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" }}>
                            <View style={{ flex: 1 }}>
                              <Text style={{ color: "#C9A84C", fontSize: 12, fontWeight: "700", marginBottom: 2 }} numberOfLines={1}>{c.courseName}</Text>
                              <Text style={{ color: Colors.muted, fontSize: 11 }}>{c.rounds} {c.rounds === 1 ? "round" : "rounds"}</Text>
                            </View>
                            <View style={{ alignItems: "flex-end", gap: 2 }}>
                              <Text style={{ color: Colors.text, fontSize: 20, fontWeight: "800" }}>{c.avgGross.toFixed(1)}</Text>
                              <Text style={{ color: Colors.muted, fontSize: 10 }}>avg gross</Text>
                            </View>
                            {c.bestGross !== null && (
                              <View style={{ alignItems: "flex-end", marginLeft: 16, gap: 2 }}>
                                <Text style={{ color: "#22c55e", fontSize: 15, fontWeight: "700" }}>{c.bestGross}</Text>
                                <Text style={{ color: Colors.muted, fontSize: 10 }}>best</Text>
                              </View>
                            )}
                          </View>
                        ))}
                      </View>
                    </View>
                  )}

                  {/* ── Proximity to Hole ── */}
                  {proximityStats && proximityStats.totalShots > 0 && (
                    <View style={styles.section}>
                      <Text style={styles.sectionTitle}>📍 Proximity to Hole</Text>
                      <Text style={{ fontSize: 11, color: Colors.muted, marginBottom: 10 }}>{proximityStats.totalShots} shots tracked</Text>
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        {[
                          { label: "Approach", key: "approach" as const, emoji: "🏌️", color: "#3b82f6" },
                          { label: "Chip", key: "chip" as const, emoji: "🏖️", color: "#22c55e" },
                          { label: "Sand", key: "sand" as const, emoji: "⛱️", color: "#f59e0b" },
                        ].map(cat => {
                          const data = proximityStats[cat.key];
                          return (
                            <View key={cat.key} style={{ flex: 1, backgroundColor: "rgba(255,255,255,0.05)", borderRadius: 12, padding: 10, alignItems: "center" }}>
                              <Text style={{ fontSize: 20, marginBottom: 4 }}>{cat.emoji}</Text>
                              <Text style={{ fontSize: 10, color: Colors.muted, marginBottom: 2 }}>{cat.label}</Text>
                              {data ? (
                                <>
                                  <Text style={{ fontSize: 18, fontWeight: "800", color: cat.color }}>{data.avgFeet}<Text style={{ fontSize: 10, color: Colors.muted }}>ft</Text></Text>
                                  <Text style={{ fontSize: 10, color: Colors.muted }}>{data.shotCount} shots</Text>
                                </>
                              ) : <Text style={{ fontSize: 12, color: Colors.muted }}>No data</Text>}
                            </View>
                          );
                        })}
                      </View>
                    </View>
                  )}

                  {/* Task #1002 — Proximity by Club (Task #1168 — adds tour benchmark marker) */}
                  {/* Task #1349 — picks primary baseline (tour / scratch / mid)
                      from handicap with a manual override the player can pin. */}
                  {/* Task #2040 — `onLayout` records the y-offset so the
                      `coaching.gap.closed` push deep-link can scroll this
                      section into view. */}
                  <View
                    onLayout={(e) => { proxByClubAnchorY.current = e.nativeEvent.layout.y; }}
                  >
                  {proxByClub && (() => {
                    const items = proxByClub.clubs.filter(c => c.shots >= 3);
                    const primary: ProxPrimaryBaseline = proxByClub.primaryBaseline ?? "tour";
                    const preferred: ProxPreferredBaseline = proxByClub.preferredBaseline ?? "auto";
                    const source: ProxBaselineSource = proxByClub.baselineSource ?? "default";
                    const hi = proxByClub.handicapIndex ?? null;
                    // Task #1644 — explain which source the handicap came
                    // from + how stale it is, so a player whose number is
                    // wrong knows exactly where to fix it.
                    const handicapSource: ProxHandicapSource | null = proxByClub.handicapSource ?? null;
                    const handicapAsOf = proxByClub.handicapAsOf ?? null;
                    const baselineConfig: Record<ProxPrimaryBaseline, { label: string; color: string; field: "tourMeanFt" | "scratchMeanFt" | "midHandicapMeanFt" }> = {
                      tour: { label: "PGA Tour", color: "#22c55e", field: "tourMeanFt" },
                      scratch: { label: "Scratch", color: "#a855f7", field: "scratchMeanFt" },
                      mid: { label: "Mid-handicap", color: "#38bdf8", field: "midHandicapMeanFt" },
                    };
                    const primaryConfig = baselineConfig[primary];
                    const sourceCopy =
                      preferred !== "auto" ? `Pinned to ${primaryConfig.label}.`
                      : source === "handicap" && hi !== null ? `Auto-picked from your ${hi.toFixed(1)} handicap.`
                      : "Default comparison (no handicap on file yet).";
                    const handicapSourceMeta: Record<ProxHandicapSource, { label: string; fix: string; href: string }> = {
                      whs: {
                        label: t("provenance.source_whs"),
                        fix: t("provenance.fix_whs"),
                        href: "/handicap-profile",
                      },
                      history: {
                        label: t("provenance.source_history"),
                        fix: t("provenance.fix_history"),
                        href: "/general-play",
                      },
                      profile: {
                        label: t("provenance.source_profile"),
                        fix: t("provenance.fix_profile"),
                        href: "/handicap-profile",
                      },
                    };
                    const fmtAsOf = (iso: string | null): string | null => {
                      if (!iso) return null;
                      const ts = new Date(iso).getTime();
                      if (!Number.isFinite(ts)) return null;
                      const days = Math.max(0, Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000)));
                      // "today" / "yesterday" stay as discrete copy because
                      // Intl.RelativeTimeFormat with `numeric: "always"`
                      // (what the shared helper uses) renders those as
                      // "0 days ago" / "1 day ago", which reads poorly. For
                      // every older bucket — "X days ago", "X months ago",
                      // "X years ago" — defer to the shared
                      // `formatRelativeTime` helper so the active locale
                      // does the heavy lifting via Intl, instead of us
                      // reproducing the bucketing here. (Task #2058)
                      if (days === 0) return t("provenance.asOfToday");
                      if (days === 1) return t("provenance.asOfYesterday");
                      return formatRelativeTime(iso);
                    };
                    const sourceMeta = handicapSource ? handicapSourceMeta[handicapSource] : null;
                    const asOfLabel = fmtAsOf(handicapAsOf);
                    const maxFt = items.length === 0 ? 1 : Math.max(
                      1,
                      ...items.map(c => Math.max(
                        c.p90ProximityFt ?? 0,
                        c.meanProximityFt ?? 0,
                        c.benchmark?.[primaryConfig.field] ?? 0,
                      )),
                    );
                    const picker = (
                      <View style={{ marginBottom: 8 }}>
                        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                          <Text style={{ color: Colors.muted, fontSize: 11, marginRight: 2 }}>Compare against:</Text>
                          {(["auto", "tour", "scratch", "mid"] as const).map(opt => {
                            const isActive = preferred === opt;
                            const label = opt === "auto" ? "Auto" : baselineConfig[opt].label;
                            return (
                              <Pressable
                                key={opt}
                                accessibilityRole="button"
                                accessibilityLabel={`Set proximity baseline to ${label}`}
                                accessibilityState={{ selected: isActive, disabled: setProxBaselinePref.isPending || isActive }}
                                disabled={setProxBaselinePref.isPending || isActive}
                                onPress={() => setProxBaselinePref.mutate(opt)}
                                style={{
                                  paddingHorizontal: 10,
                                  paddingVertical: 4,
                                  borderRadius: 999,
                                  borderWidth: 1,
                                  borderColor: isActive ? "rgba(251,191,36,0.6)" : "rgba(255,255,255,0.1)",
                                  backgroundColor: isActive ? "rgba(251,191,36,0.15)" : "rgba(255,255,255,0.04)",
                                }}
                              >
                                <Text style={{ fontSize: 11, color: isActive ? "#fcd34d" : Colors.text }}>{label}</Text>
                              </Pressable>
                            );
                          })}
                          <Text style={{ color: Colors.muted, fontSize: 10, width: "100%" }}>{sourceCopy}</Text>
                        </View>
                        {/* Task #1644 — "Where this comes from" provenance row */}
                        <View
                          testID="proximity-handicap-provenance"
                          style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 4 }}
                        >
                          <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 10, fontWeight: "600" }}>
                            {t("provenance.label")}
                          </Text>
                          {sourceMeta && hi !== null ? (
                            <>
                              <Text style={{ color: Colors.muted, fontSize: 10, flexShrink: 1 }}>
                                {asOfLabel
                                  ? t("provenance.summaryWithAsOf", {
                                      handicap: hi.toFixed(1),
                                      source: sourceMeta.label,
                                      asOf: asOfLabel,
                                    })
                                  : t("provenance.summary", {
                                      handicap: hi.toFixed(1),
                                      source: sourceMeta.label,
                                    })}
                              </Text>
                              <Pressable
                                accessibilityRole="link"
                                accessibilityLabel={sourceMeta.fix}
                                onPress={() => router.push(sourceMeta.href as never)}
                              >
                                <Text style={{ color: "#fcd34d", fontSize: 10, textDecorationLine: "underline" }}>
                                  {sourceMeta.fix}
                                </Text>
                              </Pressable>
                            </>
                          ) : (
                            <>
                              {/* Only mention "default comparison" when the
                                  chart is actually using the default — a
                                  pinned baseline takes precedence over the
                                  handicap-derived one. */}
                              <Text style={{ color: Colors.muted, fontSize: 10, flexShrink: 1 }}>
                                {preferred === "auto"
                                  ? t("provenance.noneAuto")
                                  : t("provenance.nonePinned")}
                              </Text>
                              <Pressable
                                accessibilityRole="link"
                                accessibilityLabel={t("provenance.fix_default")}
                                onPress={() => router.push("/handicap-profile" as never)}
                              >
                                <Text style={{ color: "#fcd34d", fontSize: 10, textDecorationLine: "underline" }}>
                                  {t("provenance.fix_default")}
                                </Text>
                              </Pressable>
                            </>
                          )}
                        </View>
                      </View>
                    );
                    return (
                      <View style={styles.section}>
                        <Text style={styles.sectionTitle}>📐 Proximity by Club</Text>
                        <Text style={{ fontSize: 11, color: Colors.muted, marginBottom: 6 }}>
                          Your mean (blue) and 90th-percentile (amber) distance to pin, per club.
                          The coloured tick marks the {primaryConfig.label} mean for that club —
                          the closer your blue bar reaches the tick, the tighter you are vs that cohort.
                        </Text>
                        {picker}
                        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 8 }}>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                            <View style={{ width: 10, height: 6, backgroundColor: "#60a5fa", borderRadius: 1 }} />
                            <Text style={{ color: Colors.muted, fontSize: 10 }}>You (mean)</Text>
                          </View>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                            <View style={{ width: 10, height: 6, backgroundColor: "#f59e0b", borderRadius: 1 }} />
                            <Text style={{ color: Colors.muted, fontSize: 10 }}>You (p90)</Text>
                          </View>
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                            <View style={{ width: 2, height: 10, backgroundColor: primaryConfig.color }} />
                            <Text style={{ color: Colors.muted, fontSize: 10 }}>{primaryConfig.label} mean</Text>
                          </View>
                        </View>
                        {items.length === 0 ? (
                          <Text style={{ color: Colors.muted, fontSize: 11 }}>
                            Track at least 3 approach shots per club to see proximity-by-club data.
                          </Text>
                        ) : (
                          <View style={{ gap: 8 }}>
                            {items.map(c => {
                              const mean = c.meanProximityFt ?? 0;
                              const p90 = c.p90ProximityFt ?? 0;
                              const meanW = `${Math.max(2, (mean / maxFt) * 100)}%` as const;
                              const p90W = `${Math.max(2, (p90 / maxFt) * 100)}%` as const;
                              const tourFt = c.benchmark?.tourMeanFt ?? null;
                              const scratchFt = c.benchmark?.scratchMeanFt ?? null;
                              const midFt = c.benchmark?.midHandicapMeanFt ?? null;
                              const primaryFt = c.benchmark ? c.benchmark[primaryConfig.field] : null;
                              const primaryPct = primaryFt !== null ? (primaryFt / maxFt) * 100 : null;
                              const gap = primaryFt !== null && c.meanProximityFt !== null
                                ? Math.round((c.meanProximityFt - primaryFt) * 10) / 10
                                : null;
                              // Task #1997 — fade clubs with very few shots
                              // (matches the weather-correlation treatment).
                              const lowSample = c.shots > 0 && c.shots < MIN_TRUSTWORTHY_SAMPLE;
                              const barOpacity = lowSample ? 0.4 : 1;
                              // Task #2040 — when this row matches the
                              // `focusClub` deep-link from the
                              // `coaching.gap.closed` push, briefly
                              // highlight the background so the player
                              // immediately spots the club that improved.
                              const benchmarkKey = c.benchmark?.clubKey ?? null;
                              const isFocused = highlightClubKey !== null && benchmarkKey === highlightClubKey;
                              return (
                                <View
                                  key={c.club}
                                  style={{
                                    backgroundColor: isFocused ? "rgba(34,197,94,0.18)" : "rgba(255,255,255,0.04)",
                                    borderRadius: 10,
                                    padding: 10,
                                    borderWidth: isFocused ? 1 : 0,
                                    borderColor: isFocused ? "#22c55e" : "transparent",
                                  }}
                                >
                                  <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
                                    <Text style={{ color: Colors.text, fontSize: 12, fontWeight: "700" }}>{c.club}</Text>
                                    <Text style={{ color: Colors.muted, fontSize: 11 }}>
                                      {mean.toFixed(0)} ft mean · p90 {p90.toFixed(0)} ft · {c.shots} shot{c.shots === 1 ? "" : "s"}
                                      {lowSample ? " · limited sample" : ""}
                                    </Text>
                                  </View>
                                  <View style={{ height: 8, backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 3, marginBottom: 4, position: "relative", overflow: "hidden" }}>
                                    <View style={{ width: meanW, height: "100%", backgroundColor: "#60a5fa", opacity: barOpacity }} />
                                    {primaryPct !== null && (
                                      <View
                                        pointerEvents="none"
                                        style={{
                                          position: "absolute",
                                          left: `${Math.min(100, primaryPct)}%`,
                                          top: -2,
                                          bottom: -2,
                                          width: 2,
                                          marginLeft: -1,
                                          backgroundColor: primaryConfig.color,
                                        }}
                                      />
                                    )}
                                  </View>
                                  <View style={{ height: 8, backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 3, position: "relative", overflow: "hidden" }}>
                                    <View style={{ width: p90W, height: "100%", backgroundColor: "#f59e0b", opacity: barOpacity }} />
                                    {primaryPct !== null && (
                                      <View
                                        pointerEvents="none"
                                        style={{
                                          position: "absolute",
                                          left: `${Math.min(100, primaryPct)}%`,
                                          top: -2,
                                          bottom: -2,
                                          width: 2,
                                          marginLeft: -1,
                                          backgroundColor: primaryConfig.color,
                                        }}
                                      />
                                    )}
                                  </View>
                                  {tourFt !== null && scratchFt !== null && midFt !== null && (
                                    <Text style={{ marginTop: 6, fontSize: 10, color: Colors.muted }}>
                                      <Text style={primary === "tour" ? { color: "#86efac", fontWeight: "700" } : undefined}>Tour {tourFt.toFixed(0)} ft</Text>
                                      {" · "}
                                      <Text style={primary === "scratch" ? { color: "#d8b4fe", fontWeight: "700" } : undefined}>Scratch {scratchFt.toFixed(0)} ft</Text>
                                      {" · "}
                                      <Text style={primary === "mid" ? { color: "#7dd3fc", fontWeight: "700" } : undefined}>Mid-hcp {midFt.toFixed(0)} ft</Text>
                                      {gap !== null && (
                                        <Text style={{ color: gap > 0 ? "#fbbf24" : "#22c55e" }}>
                                          {"  "}({gap >= 0 ? "+" : ""}{gap.toFixed(1)} ft vs {primaryConfig.label.toLowerCase()})
                                        </Text>
                                      )}
                                    </Text>
                                  )}
                                </View>
                              );
                            })}
                          </View>
                        )}
                      </View>
                    );
                  })()}

                  {/* Task #1348 — "Work on this club" coaching callout. The
                      same data drives the AI Caddie rationale, so on-course
                      advice stays consistent with what the player sees in
                      the post-round Shot Analytics panel. */}
                  {proxByClub?.coachingTips && proxByClub.coachingTips.length > 0 && (
                    <View style={styles.section}>
                      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                        <Text style={[styles.sectionTitle, { flexShrink: 1 }]}>🎯 Work on This Club</Text>
                        {/* Task #2041 — 30d/60d/90d toggle so players who play
                            less frequently still get a meaningful trend
                            comparison. Persists to AsyncStorage and is passed
                            to the proximity-by-club endpoint as `?days=`. */}
                        <View
                          accessibilityRole="tablist"
                          accessibilityLabel="Trend comparison window"
                          testID="trend-window-toggle"
                          style={{
                            flexDirection: "row",
                            borderWidth: 1,
                            borderColor: "rgba(255,255,255,0.12)",
                            backgroundColor: "rgba(255,255,255,0.04)",
                            borderRadius: 8,
                            padding: 2,
                          }}
                        >
                          {([30, 60, 90] as const).map(days => {
                            const active = trendWindowDays === days;
                            return (
                              <TouchableOpacity
                                key={days}
                                accessibilityRole="tab"
                                accessibilityState={{ selected: active }}
                                accessibilityLabel={`Compare against the prior ${days} days`}
                                testID={`trend-window-${days}d`}
                                onPress={() => setTrendWindowDays(days)}
                                style={{
                                  paddingHorizontal: 8,
                                  paddingVertical: 4,
                                  borderRadius: 6,
                                  backgroundColor: active ? "rgba(251,191,36,0.18)" : "transparent",
                                }}
                              >
                                <Text style={{ color: active ? "#fbbf24" : Colors.muted, fontSize: 11, fontWeight: "700" }}>
                                  {days}d
                                </Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      </View>
                      <Text style={{ fontSize: 11, color: Colors.muted, marginBottom: 10, marginTop: 4 }}>
                        Where you're losing the most strokes vs the PGA-tour benchmark.
                      </Text>
                      <View style={{ gap: 8 }}>
                        {proxByClub.coachingTips.map(tip => {
                          // Task #1640 — colour-cue the trend annotation so the
                          // player can scan whether each tip is improving
                          // (green), holding (muted), or slipping (amber).
                          // Sub-0.5-ft moves stay muted to match the "no
                          // change" label the helper renders for them.
                          const trendColor = tip.trendVsTourFt === null || Math.abs(tip.trendVsTourFt) < 0.5
                            ? Colors.muted
                            : tip.trendVsTourFt < 0
                              ? "#34d399"
                              : "#fbbf24";
                          return (
                            <View
                              key={tip.clubKey}
                              style={{
                                backgroundColor: "rgba(251,191,36,0.08)",
                                borderColor: "rgba(251,191,36,0.35)",
                                borderWidth: 1,
                                borderRadius: 10,
                                padding: 10,
                              }}
                            >
                              <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 4 }}>
                                <Text style={{ color: Colors.text, fontSize: 13, fontWeight: "700" }}>{tip.club}</Text>
                                <Text style={{ color: "#fbbf24", fontSize: 11, fontWeight: "600" }}>
                                  +{tip.gapVsTourFt.toFixed(1)} ft vs tour
                                </Text>
                              </View>
                              <Text style={{ color: Colors.text, fontSize: 12, marginBottom: 4 }}>{tip.message}</Text>
                              {(tip.trendLabel !== null || (tip.weeklyGapHistory?.some(b => b.gapVsTourFt !== null) ?? false)) && (
                                <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 4 }}>
                                  {tip.trendLabel !== null && (
                                    <Text
                                      style={{ color: trendColor, fontSize: 11, fontWeight: "600", marginRight: 8 }}
                                      testID={`coaching-tip-trend-${tip.clubKey}`}
                                    >
                                      {tip.trendLabel}
                                    </Text>
                                  )}
                                  {/* Task #2039 — inline 6-bucket gap-vs-tour
                                      sparkline next to the trend label. Same
                                      green/amber/muted colour cue as the web
                                      card so the trend reads at a glance.
                                      Buckets with zero shots are skipped so a
                                      week off doesn't drag the line. */}
                                  {(() => {
                                    const hist = tip.weeklyGapHistory ?? [];
                                    const present = hist
                                      .map(b => b.gapVsTourFt)
                                      .filter((v): v is number => v !== null);
                                    if (present.length < 2) return null;
                                    const sparkColor = tip.trendVsTourFt === null || Math.abs(tip.trendVsTourFt) < 0.5
                                      ? Colors.muted
                                      : tip.trendVsTourFt < 0
                                        ? "#34d399"
                                        : "#fbbf24";
                                    const w = 64;
                                    const h = 18;
                                    const padX = 1;
                                    const padY = 2;
                                    const min = Math.min(...present);
                                    const max = Math.max(...present);
                                    const range = max - min || 1;
                                    const stepX = (w - padX * 2) / Math.max(1, hist.length - 1);
                                    const points = hist
                                      .map((b, i) => {
                                        if (b.gapVsTourFt === null) return null;
                                        const x = padX + i * stepX;
                                        const y = padY + (h - padY * 2) * (1 - (b.gapVsTourFt - min) / range);
                                        return `${x.toFixed(2)},${y.toFixed(2)}`;
                                      })
                                      .filter((p): p is string => p !== null)
                                      .join(" ");
                                    const last = hist[hist.length - 1];
                                    const lastIsPresent = last && last.gapVsTourFt !== null;
                                    const lastX = padX + (hist.length - 1) * stepX;
                                    const lastY = lastIsPresent
                                      ? padY + (h - padY * 2) * (1 - (last!.gapVsTourFt! - min) / range)
                                      : null;
                                    const summary = `Last ${hist.length} weeks of gap vs tour: ${
                                      hist.map(b => b.gapVsTourFt === null ? "no data" : `${b.gapVsTourFt > 0 ? "+" : ""}${b.gapVsTourFt.toFixed(1)} ft`).join(", ")
                                    }`;
                                    return (
                                      <Svg
                                        width={w}
                                        height={h}
                                        accessibilityRole="image"
                                        accessibilityLabel={summary}
                                        testID={`coaching-tip-sparkline-${tip.clubKey}`}
                                      >
                                        <Polyline
                                          points={points}
                                          fill="none"
                                          stroke={sparkColor}
                                          strokeWidth={1.5}
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                        />
                                        {lastY !== null && (
                                          <Circle cx={lastX} cy={lastY} r={1.75} fill={sparkColor} />
                                        )}
                                      </Svg>
                                    );
                                  })()}
                                </View>
                              )}
                              <Text style={{ color: Colors.muted, fontSize: 10 }}>
                                You {tip.meanProximityFt.toFixed(0)} ft · scratch {tip.scratchMeanFt.toFixed(0)} ft · tour {tip.tourMeanFt.toFixed(0)} ft
                                {tip.practiceDistanceYards !== null ? ` · practice from ${tip.practiceDistanceYards} yds` : ""}
                              </Text>
                              {/* Task #1641 — one-tap deep-link into the
                                  practice logger, pre-filled with this tip's
                                  club + distance band. */}
                              <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 8 }}>
                                <TouchableOpacity
                                  accessibilityRole="button"
                                  accessibilityLabel={`Log practice for ${tip.club}`}
                                  testID={`coaching-tip-log-practice-${tip.clubKey}`}
                                  onPress={() => startPracticeFromTip({
                                    club: tip.club,
                                    clubKey: tip.clubKey,
                                    practiceDistanceYards: tip.practiceDistanceYards,
                                  })}
                                  style={{
                                    borderColor: "rgba(251,191,36,0.6)",
                                    borderWidth: 1,
                                    borderRadius: 8,
                                    paddingHorizontal: 10,
                                    paddingVertical: 6,
                                  }}
                                >
                                  <Text style={{ color: "#fbbf24", fontSize: 11, fontWeight: "700" }}>
                                    Log practice
                                  </Text>
                                </TouchableOpacity>
                              </View>
                            </View>
                          );
                        })}
                      </View>
                    </View>
                  )}
                  </View>

                  {/* Task #1002 — Weather Correlation (Wind) */}
                  {weatherCorr && weatherCorr.windBuckets.some(b => b.rounds > 0) && (() => {
                    const maxAbs = Math.max(0.1, ...weatherCorr.windBuckets.map(b => Math.abs(b.sgDelta ?? 0)));
                    return (
                      <View style={styles.section}>
                        <Text style={styles.sectionTitle}>🌬️ Wind vs Scoring</Text>
                        <Text style={{ fontSize: 11, color: Colors.muted, marginBottom: 10 }}>
                          SG-Total delta vs your {weatherCorr.windowDays}-day baseline
                          {weatherCorr.baselineSgTotal != null && weatherCorr.baselineRoundCount > 0
                            ? ` (${(weatherCorr.baselineSgTotal >= 0 ? "+" : "") + weatherCorr.baselineSgTotal.toFixed(2)} over ${weatherCorr.baselineRoundCount} rounds)`
                            : ""}
                          .
                        </Text>
                        <View style={{ gap: 8 }}>
                          {weatherCorr.windBuckets.map(b => {
                            const delta = b.sgDelta ?? 0;
                            const pct = `${(Math.abs(delta) / maxAbs) * 50}%` as const;
                            const positive = delta >= 0;
                            const lowSample = b.rounds > 0 && b.rounds < MIN_TRUSTWORTHY_WEATHER_ROUNDS;
                            const barOpacity = lowSample ? 0.4 : 1;
                            return (
                              <View key={b.label} style={{ backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 10, padding: 10 }}>
                                <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
                                  <Text style={{ color: Colors.text, fontSize: 12, fontWeight: "700" }}>{b.label}</Text>
                                  <Text style={{ color: Colors.muted, fontSize: 11 }}>
                                    {b.rounds} round{b.rounds === 1 ? "" : "s"}
                                    {b.sgDelta != null ? ` · ${(delta >= 0 ? "+" : "") + delta.toFixed(2)} SG` : " · no data"}
                                    {lowSample ? " · limited sample" : ""}
                                  </Text>
                                </View>
                                <View style={{ height: 8, backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 4, overflow: "hidden", flexDirection: "row" }}>
                                  <View style={{ flex: 1, alignItems: "flex-end", justifyContent: "center" }}>
                                    {!positive && b.rounds > 0 && (
                                      <View style={{ height: "100%", width: pct, backgroundColor: "#ef4444", opacity: barOpacity }} />
                                    )}
                                  </View>
                                  <View style={{ width: 1, backgroundColor: "rgba(255,255,255,0.25)" }} />
                                  <View style={{ flex: 1, alignItems: "flex-start", justifyContent: "center" }}>
                                    {positive && b.rounds > 0 && (
                                      <View style={{ height: "100%", width: pct, backgroundColor: "#22c55e", opacity: barOpacity }} />
                                    )}
                                  </View>
                                </View>
                              </View>
                            );
                          })}
                        </View>
                      </View>
                    );
                  })()}

                  {/* Task #1002 — Weather Correlation (Temperature) */}
                  {weatherCorr && weatherCorr.temperatureBuckets && weatherCorr.temperatureBuckets.some(b => b.rounds > 0) && (() => {
                    const maxAbs = Math.max(0.1, ...weatherCorr.temperatureBuckets.map(b => Math.abs(b.sgDelta ?? 0)));
                    return (
                      <View style={styles.section}>
                        <Text style={styles.sectionTitle}>🌡️ Temperature vs Scoring</Text>
                        <Text style={{ fontSize: 11, color: Colors.muted, marginBottom: 10 }}>
                          SG-Total delta vs your {weatherCorr.windowDays}-day baseline by temperature range.
                        </Text>
                        <View style={{ gap: 8 }}>
                          {weatherCorr.temperatureBuckets.map(b => {
                            const delta = b.sgDelta ?? 0;
                            const pct = `${(Math.abs(delta) / maxAbs) * 50}%` as const;
                            const positive = delta >= 0;
                            const lowSample = b.rounds > 0 && b.rounds < MIN_TRUSTWORTHY_WEATHER_ROUNDS;
                            const barOpacity = lowSample ? 0.4 : 1;
                            return (
                              <View key={b.label} style={{ backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 10, padding: 10 }}>
                                <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
                                  <Text style={{ color: Colors.text, fontSize: 12, fontWeight: "700" }}>{b.label}</Text>
                                  <Text style={{ color: Colors.muted, fontSize: 11 }}>
                                    {b.rounds} round{b.rounds === 1 ? "" : "s"}
                                    {b.sgDelta != null ? ` · ${(delta >= 0 ? "+" : "") + delta.toFixed(2)} SG` : " · no data"}
                                    {lowSample ? " · limited sample" : ""}
                                  </Text>
                                </View>
                                <View style={{ height: 8, backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 4, overflow: "hidden", flexDirection: "row" }}>
                                  <View style={{ flex: 1, alignItems: "flex-end", justifyContent: "center" }}>
                                    {!positive && b.rounds > 0 && (
                                      <View style={{ height: "100%", width: pct, backgroundColor: "#ef4444", opacity: barOpacity }} />
                                    )}
                                  </View>
                                  <View style={{ width: 1, backgroundColor: "rgba(255,255,255,0.25)" }} />
                                  <View style={{ flex: 1, alignItems: "flex-start", justifyContent: "center" }}>
                                    {positive && b.rounds > 0 && (
                                      <View style={{ height: "100%", width: pct, backgroundColor: "#22c55e", opacity: barOpacity }} />
                                    )}
                                  </View>
                                </View>
                              </View>
                            );
                          })}
                        </View>
                      </View>
                    );
                  })()}

                  {/* Task #1347 — Weather Correlation (Humidity) */}
                  {weatherCorr && weatherCorr.humidityBuckets && weatherCorr.humidityBuckets.some(b => b.rounds > 0) && (() => {
                    const maxAbs = Math.max(0.1, ...weatherCorr.humidityBuckets.map(b => Math.abs(b.sgDelta ?? 0)));
                    return (
                      <View style={styles.section}>
                        <Text style={styles.sectionTitle}>💧 Humidity vs Scoring</Text>
                        <Text style={{ fontSize: 11, color: Colors.muted, marginBottom: 10 }}>
                          SG-Total delta vs your {weatherCorr.windowDays}-day baseline by humidity range.
                        </Text>
                        <View style={{ gap: 8 }}>
                          {weatherCorr.humidityBuckets.map(b => {
                            const delta = b.sgDelta ?? 0;
                            const pct = `${(Math.abs(delta) / maxAbs) * 50}%` as const;
                            const positive = delta >= 0;
                            const lowSample = b.rounds > 0 && b.rounds < MIN_TRUSTWORTHY_WEATHER_ROUNDS;
                            const barOpacity = lowSample ? 0.4 : 1;
                            return (
                              <View key={b.label} style={{ backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 10, padding: 10 }}>
                                <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
                                  <Text style={{ color: Colors.text, fontSize: 12, fontWeight: "700" }}>{b.label}</Text>
                                  <Text style={{ color: Colors.muted, fontSize: 11 }}>
                                    {b.rounds} round{b.rounds === 1 ? "" : "s"}
                                    {b.sgDelta != null ? ` · ${(delta >= 0 ? "+" : "") + delta.toFixed(2)} SG` : " · no data"}
                                    {lowSample ? " · limited sample" : ""}
                                  </Text>
                                </View>
                                <View style={{ height: 8, backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 4, overflow: "hidden", flexDirection: "row" }}>
                                  <View style={{ flex: 1, alignItems: "flex-end", justifyContent: "center" }}>
                                    {!positive && b.rounds > 0 && (
                                      <View style={{ height: "100%", width: pct, backgroundColor: "#ef4444", opacity: barOpacity }} />
                                    )}
                                  </View>
                                  <View style={{ width: 1, backgroundColor: "rgba(255,255,255,0.25)" }} />
                                  <View style={{ flex: 1, alignItems: "flex-start", justifyContent: "center" }}>
                                    {positive && b.rounds > 0 && (
                                      <View style={{ height: "100%", width: pct, backgroundColor: "#22c55e", opacity: barOpacity }} />
                                    )}
                                  </View>
                                </View>
                              </View>
                            );
                          })}
                        </View>
                      </View>
                    );
                  })()}

                  {/* Task #1347 — Weather Correlation (Precipitation) */}
                  {weatherCorr && weatherCorr.precipitationBuckets && weatherCorr.precipitationBuckets.some(b => b.rounds > 0) && (() => {
                    const maxAbs = Math.max(0.1, ...weatherCorr.precipitationBuckets.map(b => Math.abs(b.sgDelta ?? 0)));
                    return (
                      <View style={styles.section}>
                        <Text style={styles.sectionTitle}>🌧️ Rain vs Scoring</Text>
                        <Text style={{ fontSize: 11, color: Colors.muted, marginBottom: 10 }}>
                          SG-Total delta vs your {weatherCorr.windowDays}-day baseline by precipitation range.
                        </Text>
                        <View style={{ gap: 8 }}>
                          {weatherCorr.precipitationBuckets.map(b => {
                            const delta = b.sgDelta ?? 0;
                            const pct = `${(Math.abs(delta) / maxAbs) * 50}%` as const;
                            const positive = delta >= 0;
                            const lowSample = b.rounds > 0 && b.rounds < MIN_TRUSTWORTHY_WEATHER_ROUNDS;
                            const barOpacity = lowSample ? 0.4 : 1;
                            return (
                              <View key={b.label} style={{ backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 10, padding: 10 }}>
                                <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
                                  <Text style={{ color: Colors.text, fontSize: 12, fontWeight: "700" }}>{b.label}</Text>
                                  <Text style={{ color: Colors.muted, fontSize: 11 }}>
                                    {b.rounds} round{b.rounds === 1 ? "" : "s"}
                                    {b.sgDelta != null ? ` · ${(delta >= 0 ? "+" : "") + delta.toFixed(2)} SG` : " · no data"}
                                    {lowSample ? " · limited sample" : ""}
                                  </Text>
                                </View>
                                <View style={{ height: 8, backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 4, overflow: "hidden", flexDirection: "row" }}>
                                  <View style={{ flex: 1, alignItems: "flex-end", justifyContent: "center" }}>
                                    {!positive && b.rounds > 0 && (
                                      <View style={{ height: "100%", width: pct, backgroundColor: "#ef4444", opacity: barOpacity }} />
                                    )}
                                  </View>
                                  <View style={{ width: 1, backgroundColor: "rgba(255,255,255,0.25)" }} />
                                  <View style={{ flex: 1, alignItems: "flex-start", justifyContent: "center" }}>
                                    {positive && b.rounds > 0 && (
                                      <View style={{ height: "100%", width: pct, backgroundColor: "#22c55e", opacity: barOpacity }} />
                                    )}
                                  </View>
                                </View>
                              </View>
                            );
                          })}
                        </View>
                      </View>
                    );
                  })()}

                  {/* Hole Averages — Front 9 / Back 9 toggle, no horizontal scroll */}
                  {stats.holeAverages.length > 0 && (
                    <View style={styles.section}>
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                        <Text style={styles.sectionTitle}>Hole Averages</Text>
                        <View style={styles.holeToggle}>
                          <TouchableOpacity
                            style={[styles.holeToggleBtn, holeViewSide === "front" && styles.holeToggleBtnActive]}
                            onPress={() => setHoleViewSide("front")}
                          >
                            <Text style={[styles.holeToggleBtnText, holeViewSide === "front" && styles.holeToggleBtnTextActive]}>Front 9</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={[styles.holeToggleBtn, holeViewSide === "back" && styles.holeToggleBtnActive]}
                            onPress={() => setHoleViewSide("back")}
                          >
                            <Text style={[styles.holeToggleBtnText, holeViewSide === "back" && styles.holeToggleBtnTextActive]}>Back 9</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                      {(() => {
                        const holes = stats.holeAverages.filter(h =>
                          holeViewSide === "front" ? h.holeNumber <= 9 : h.holeNumber > 9
                        );
                        return (
                          <View>
                            <View style={styles.holeRow}>
                              <Text style={[styles.holeCell, styles.holeLabelCell]}>Hole</Text>
                              {holes.map(h => <Text key={h.holeNumber} style={styles.holeCell}>{h.holeNumber}</Text>)}
                            </View>
                            <View style={styles.holeRow}>
                              <Text style={[styles.holeCell, styles.holeLabelCell]}>Avg</Text>
                              {holes.map(h => <Text key={h.holeNumber} style={styles.holeCell}>{h.avgStrokes?.toFixed(1) ?? "—"}</Text>)}
                            </View>
                            <View style={styles.holeRow}>
                              <Text style={[styles.holeCell, styles.holeLabelCell]}>+/-</Text>
                              {holes.map(h => {
                                const tp = h.avgToPar ?? 0;
                                const col = tp <= -1 ? "#22c55e" : tp === 0 ? "#3b82f6" : tp <= 1 ? "#f97316" : "#ef4444";
                                return (
                                  <Text key={h.holeNumber} style={[styles.holeCell, { color: col, fontWeight: "700" }]}>
                                    {tp > 0 ? "+" : ""}{tp?.toFixed(1)}
                                  </Text>
                                );
                              })}
                            </View>
                          </View>
                        );
                      })()}
                    </View>
                  )}
                </>
              )}
            </>
          ) : tab === "achievements" ? (
            <>
              {!achievements || achievements.length === 0 ? (
                <View style={styles.empty}>
                  <Text style={{ fontSize: 40 }}>🏅</Text>
                  <Text style={styles.emptyTitle}>No badges yet</Text>
                  <Text style={styles.emptyText}>Play tournaments and complete challenges to earn achievement badges.</Text>
                </View>
              ) : (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>{achievements.length} Badge{achievements.length !== 1 ? "s" : ""} Earned</Text>
                  <View style={styles.badgeGrid}>
                    {achievements.map(a => (
                      <View key={a.id} style={styles.badge}>
                        <Text style={{ fontSize: 28 }}>{a.badgeIcon}</Text>
                        <Text style={styles.badgeLabel}>{a.badgeLabel}</Text>
                        <Text style={styles.badgeDate}>{new Date(a.earnedAt).toLocaleDateString()}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              )}
            </>
          ) : tab === "clubs" ? (
            /* Club Distances Tab — with gapping analysis & manual distance editing */
            <>
              {/* Manual Club Distance Profile */}
              <View style={styles.section}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <Text style={styles.sectionTitle}>📏 Club Distance Profile</Text>
                  <TouchableOpacity
                    onPress={() => { setEditingClub("__new__"); setEditingCarry(""); }}
                    style={{ backgroundColor: Colors.primary + "20", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: Colors.primary + "50" }}
                  >
                    <Text style={{ color: Colors.primary, fontSize: 12, fontWeight: "700" }}>+ Add</Text>
                  </TouchableOpacity>
                </View>

                {/* New club add row */}
                {editingClub === "__new__" && (
                  <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: "rgba(201,168,76,0.08)", borderRadius: 10, padding: 10, marginBottom: 8, borderWidth: 1, borderColor: Colors.primary + "40", gap: 8 }}>
                    <TextInput
                      placeholder="Club name" placeholderTextColor={Colors.muted}
                      style={{ flex: 1, color: Colors.text, fontSize: 13, borderBottomWidth: 1, borderBottomColor: Colors.primary + "40", paddingBottom: 4 }}
                      value={editingCarry.includes(":") ? editingCarry.split(":")[0] : ""}
                      onChangeText={v => setEditingCarry(v + ":" + (editingCarry.split(":")[1] ?? ""))}
                    />
                    <TextInput
                      placeholder="Yards" placeholderTextColor={Colors.muted}
                      keyboardType="number-pad"
                      style={{ width: 60, color: Colors.text, fontSize: 13, textAlign: "center", borderBottomWidth: 1, borderBottomColor: Colors.primary + "40", paddingBottom: 4 }}
                      value={editingCarry.split(":")[1] ?? ""}
                      onChangeText={v => setEditingCarry((editingCarry.split(":")[0] ?? "") + ":" + v)}
                    />
                    <TouchableOpacity onPress={() => {
                      const [club, carryStr] = editingCarry.split(":");
                      const carry = parseInt(carryStr ?? "");
                      if (club?.trim() && !isNaN(carry) && carry > 0) saveClubDistance(club.trim(), carry);
                      else setEditingClub(null);
                    }}>
                      <Text style={{ color: "#22c55e", fontSize: 18 }}>✓</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setEditingClub(null)}>
                      <Text style={{ color: Colors.muted, fontSize: 18 }}>✕</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {(clubGapping?.clubs ?? []).length === 0 && clubProfile.filter(c => c.club).length === 0 ? (
                  <View style={{ alignItems: "center", paddingVertical: 20 }}>
                    <Text style={{ fontSize: 32, marginBottom: 8 }}>⛳</Text>
                    <Text style={{ color: Colors.muted, fontSize: 13, textAlign: "center" }}>No club data yet. Tap "+ Add" to enter your carry distances.</Text>
                  </View>
                ) : (
                  <>
                    {/* Merged club list from gapping (overrides + tracked) */}
                    {(clubGapping?.clubs ?? []).map((c, i) => (
                      <View key={i} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.05)" }}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: Colors.text, fontSize: 13, fontWeight: "600" }}>{c.club}{c.manualOverride ? " ✎" : ""}</Text>
                          {c.shotCount > 0 && <Text style={{ color: Colors.muted, fontSize: 10 }}>{c.shotCount} shots tracked</Text>}
                        </View>
                        {editingClub === c.club ? (
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                            <TextInput
                              keyboardType="number-pad"
                              style={{ color: Colors.text, fontSize: 15, fontWeight: "700", width: 60, textAlign: "center", borderWidth: 1, borderColor: Colors.primary, borderRadius: 6, paddingVertical: 4 }}
                              value={editingCarry}
                              onChangeText={setEditingCarry}
                              autoFocus
                            />
                            <Text style={{ color: Colors.muted, fontSize: 11 }}>yds</Text>
                            <TouchableOpacity onPress={() => saveClubDistance(c.club, parseInt(editingCarry))}>
                              <Text style={{ color: "#22c55e", fontSize: 18 }}>✓</Text>
                            </TouchableOpacity>
                            <TouchableOpacity onPress={() => setEditingClub(null)}>
                              <Text style={{ color: Colors.muted, fontSize: 18 }}>✕</Text>
                            </TouchableOpacity>
                          </View>
                        ) : (
                          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                            <Text style={{ color: Colors.primary, fontWeight: "800", fontSize: 17 }}>{c.avgCarry}<Text style={{ fontSize: 11, color: Colors.muted }}> yds</Text></Text>
                            <TouchableOpacity onPress={() => { setEditingClub(c.club); setEditingCarry(String(c.avgCarry)); }}>
                              <Text style={{ color: Colors.muted, fontSize: 14 }}>✎</Text>
                            </TouchableOpacity>
                            {c.manualOverride && (
                              <TouchableOpacity onPress={() => deleteClubOverride(c.club)}>
                                <Text style={{ color: "#ef4444", fontSize: 14 }}>✕</Text>
                              </TouchableOpacity>
                            )}
                          </View>
                        )}
                      </View>
                    ))}
                    {/* Tracked shot profile (if separate from gapping data) */}
                    {clubGapping?.clubs.length === 0 && clubProfile.filter(c => c.club).map((c, i) => {
                      const maxDist = Math.max(...clubProfile.filter(x => x.club).map(x => x.avgDistance ?? 0), 1);
                      const pct = (c.avgDistance ?? 0) / maxDist;
                      return (
                        <View key={i} style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
                          <Text style={{ width: 72, fontSize: 12, color: Colors.textSecondary, fontWeight: "600" }}>{c.club}</Text>
                          <View style={{ flex: 1, height: 10, backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 5, overflow: "hidden", marginHorizontal: 8 }}>
                            <View style={{ height: 10, borderRadius: 5, backgroundColor: Colors.primary, width: `${Math.round(pct * 100)}%` }} />
                          </View>
                          <Text style={{ width: 52, textAlign: "right", fontSize: 13, fontWeight: "700", color: Colors.primary }}>{(c.avgDistance ?? 0).toFixed(0)}y</Text>
                        </View>
                      );
                    })}
                  </>
                )}
              </View>

              {/* Gap Analysis */}
              {(clubGapping?.gaps ?? []).length > 0 && (
                <View style={{ marginHorizontal: 16, marginBottom: 16, backgroundColor: "rgba(249,115,22,0.07)", borderRadius: 14, padding: 14, borderWidth: 1, borderColor: "rgba(249,115,22,0.2)" }}>
                  <Text style={{ color: "#f97316", fontSize: 13, fontWeight: "700", marginBottom: 8 }}>⚠️ Gap Analysis — {clubGapping!.gaps.length} gap{clubGapping!.gaps.length !== 1 ? "s" : ""} found</Text>
                  {(clubGapping?.gaps ?? []).map((gap, i) => (
                    <View key={i} style={{ flexDirection: "row", gap: 8, marginBottom: 6 }}>
                      <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: "rgba(249,115,22,0.2)", alignItems: "center", justifyContent: "center", marginTop: 2 }}>
                        <Text style={{ color: "#f97316", fontSize: 10, fontWeight: "800" }}>{gap.gapYards}y</Text>
                      </View>
                      <Text style={{ flex: 1, color: "rgba(255,255,255,0.7)", fontSize: 12 }}>{gap.suggestion}</Text>
                    </View>
                  ))}
                </View>
              )}
            </>
          ) : tab === "compare" ? (
            /* ── Compare Tab ── */
            <View style={{ flex: 1 }}>
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>⚔️ Head-to-Head Comparison</Text>
                <Text style={{ color: Colors.muted, fontSize: 12, marginBottom: 12 }}>Compare your stats side-by-side with another member</Text>
                {orgMembers.length === 0 ? (
                  <Text style={{ color: Colors.muted, fontSize: 13, textAlign: "center", paddingVertical: 12 }}>No other members found. Join an organization to compare with club members.</Text>
                ) : (
                  <>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
                      {orgMembers.slice(0, 20).map(m => (
                        <TouchableOpacity key={m.userId} onPress={() => setCompareUserId(compareUserId === m.userId ? null : m.userId)}
                          style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, borderWidth: 1, borderColor: compareUserId === m.userId ? Colors.primary : "rgba(255,255,255,0.15)", backgroundColor: compareUserId === m.userId ? Colors.primary + "20" : "transparent" }}>
                          <Text style={{ fontSize: 12, fontWeight: "600", color: compareUserId === m.userId ? Colors.primary : Colors.textSecondary }}>{m.displayName}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                    {compareUserId && (
                      compareFetching ? (
                        <LoadingSpinner color={Colors.primary} style={{ marginTop: 12 }} />
                      ) : compareStats ? (
                        <View>
                          <View style={{ flexDirection: "row", marginBottom: 8 }}>
                            <Text style={{ flex: 1, color: Colors.primary, fontSize: 13, fontWeight: "700", textAlign: "center" }}>{compareStats.me.displayName}</Text>
                            <Text style={{ width: 80, color: Colors.muted, fontSize: 11, textAlign: "center" }}>vs</Text>
                            <Text style={{ flex: 1, color: "#60a5fa", fontSize: 13, fontWeight: "700", textAlign: "center" }}>{compareStats.them.displayName}</Text>
                          </View>
                          {[
                            { label: "Handicap Index", meVal: compareStats.me.handicapIndex?.toFixed(1) ?? "—", themVal: compareStats.them.handicapIndex?.toFixed(1) ?? "—", lowerBetter: true },
                            { label: "Scoring Avg", meVal: compareStats.me.scoringAvg?.toFixed(1) ?? "—", themVal: compareStats.them.scoringAvg?.toFixed(1) ?? "—", lowerBetter: true },
                            { label: "Rounds", meVal: String(compareStats.me.roundsPlayed), themVal: String(compareStats.them.roundsPlayed), lowerBetter: false },
                            { label: "GIR %", meVal: compareStats.me.girPct !== null ? `${compareStats.me.girPct}%` : "—", themVal: compareStats.them.girPct !== null ? `${compareStats.them.girPct}%` : "—", lowerBetter: false },
                            { label: "FIR %", meVal: compareStats.me.fairwayPct !== null ? `${compareStats.me.fairwayPct}%` : "—", themVal: compareStats.them.fairwayPct !== null ? `${compareStats.them.fairwayPct}%` : "—", lowerBetter: false },
                            { label: "Avg Putts", meVal: compareStats.me.avgPutts?.toFixed(2) ?? "—", themVal: compareStats.them.avgPutts?.toFixed(2) ?? "—", lowerBetter: true },
                            { label: "SG: Putting", meVal: compareStats.me.sgPutting !== null ? (compareStats.me.sgPutting >= 0 ? "+" : "") + compareStats.me.sgPutting.toFixed(2) : "—", themVal: compareStats.them.sgPutting !== null ? (compareStats.them.sgPutting >= 0 ? "+" : "") + compareStats.them.sgPutting.toFixed(2) : "—", lowerBetter: false },
                            { label: "SG: Approach", meVal: compareStats.me.sgApproach !== null ? (compareStats.me.sgApproach >= 0 ? "+" : "") + compareStats.me.sgApproach.toFixed(2) : "—", themVal: compareStats.them.sgApproach !== null ? (compareStats.them.sgApproach >= 0 ? "+" : "") + compareStats.them.sgApproach.toFixed(2) : "—", lowerBetter: false },
                          ].map((row, i) => {
                            const meNum = parseFloat(String(row.meVal).replace(/[^0-9.-]/g, ""));
                            const themNum = parseFloat(String(row.themVal).replace(/[^0-9.-]/g, ""));
                            const meWins = !isNaN(meNum) && !isNaN(themNum) && (row.lowerBetter ? meNum < themNum : meNum > themNum);
                            const themWins = !isNaN(meNum) && !isNaN(themNum) && (row.lowerBetter ? themNum < meNum : themNum > meNum);
                            return (
                              <View key={i} style={{ flexDirection: "row", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" }}>
                                <Text style={{ flex: 1, fontSize: 14, fontWeight: "700", textAlign: "center", color: meWins ? "#22c55e" : Colors.text }}>{row.meVal}</Text>
                                <Text style={{ width: 80, fontSize: 10, color: Colors.muted, textAlign: "center", paddingTop: 2 }}>{row.label}</Text>
                                <Text style={{ flex: 1, fontSize: 14, fontWeight: "700", textAlign: "center", color: themWins ? "#22c55e" : Colors.text }}>{row.themVal}</Text>
                              </View>
                            );
                          })}
                        </View>
                      ) : (
                        <Text style={{ color: Colors.muted, textAlign: "center", marginTop: 12 }}>Could not load comparison data.</Text>
                      )
                    )}
                  </>
                )}
              </View>
            </View>
          ) : tab === "practice" ? (
            /* Practice Session Tab */
            <>
              {/* Stats row */}
              <View style={{ flexDirection: "row", flexWrap: "wrap", marginHorizontal: 16, marginTop: 12, gap: 8 }}>
                {[
                  { label: "This Week", value: practiceStats?.thisWeek ?? 0 },
                  { label: "This Month", value: practiceStats?.thisMonth ?? 0 },
                  { label: "Streak 🔥", value: `${practiceStats?.streak ?? 0}d` },
                  { label: "Total", value: practiceStats?.total ?? 0 },
                ].map(s => (
                  <View key={s.label} style={{ flex: 1, minWidth: "45%", backgroundColor: Colors.surface, borderRadius: 14, padding: 14, alignItems: "center" }}>
                    <Text style={{ fontSize: 24, fontWeight: "800", color: Colors.primary }}>{s.value}</Text>
                    <Text style={{ fontSize: 11, color: Colors.textSecondary, marginTop: 2 }}>{s.label}</Text>
                  </View>
                ))}
              </View>

              {/* Log button */}
              <View style={{ marginHorizontal: 16, marginTop: 16 }}>
                <TouchableOpacity
                  style={{ backgroundColor: Colors.primary, borderRadius: 14, paddingVertical: 14, alignItems: "center" }}
                  onPress={() => {
                    // Task #1641 — clear any leftover coaching-tip metadata
                    // both when canceling and when opening fresh manually so
                    // the next save isn't mis-tagged as "coaching_tip" and
                    // contaminating cohort splits.
                    setPracticeForm(EMPTY_PRACTICE_FORM);
                    setLogFormOpen(v => !v);
                  }}
                >
                  <Text style={{ color: "#fff", fontWeight: "700", fontSize: 15 }}>{logFormOpen ? "✕  Cancel" : "+ Log Practice Session"}</Text>
                </TouchableOpacity>
              </View>

              {/* Log form */}
              {logFormOpen && (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>Session Type</Text>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                    {Object.entries(SESSION_TYPE_META).map(([key, { label, icon }]) => (
                      <TouchableOpacity
                        key={key}
                        onPress={() => setPracticeForm(f => ({ ...f, sessionType: key }))}
                        style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: practiceForm.sessionType === key ? Colors.primary : "rgba(255,255,255,0.1)", backgroundColor: practiceForm.sessionType === key ? Colors.primary + "20" : "transparent" }}
                      >
                        <Text style={{ fontSize: 14 }}>{icon}</Text>
                        <Text style={{ fontSize: 12, fontWeight: "600", color: practiceForm.sessionType === key ? Colors.primary : Colors.textSecondary }}>{label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <Text style={[styles.sectionTitle, { marginBottom: 8 }]}>Duration (minutes)</Text>
                  <View style={{ backgroundColor: "rgba(255,255,255,0.05)", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.08)" }}>
                    <Text style={{ color: Colors.text, fontSize: 14 }}>{practiceForm.durationMinutes || "e.g. 60"}</Text>
                  </View>
                  <View style={{ flexDirection: "row", gap: 8, marginBottom: 8 }}>
                    {["30", "45", "60", "90", "120"].map(v => (
                      <TouchableOpacity key={v} onPress={() => setPracticeForm(f => ({ ...f, durationMinutes: v }))}
                        style={{ flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: "center", backgroundColor: practiceForm.durationMinutes === v ? Colors.primary : "rgba(255,255,255,0.06)" }}>
                        <Text style={{ fontSize: 12, color: practiceForm.durationMinutes === v ? "#fff" : Colors.textSecondary, fontWeight: "600" }}>{v}m</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <TouchableOpacity
                    style={{ backgroundColor: Colors.primary, borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 4 }}
                    onPress={logPractice}
                    disabled={loggingPractice}
                  >
                    <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>{loggingPractice ? "Saving…" : "Save Session"}</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Session history */}
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Session History</Text>
                {practiceSessions.length === 0 ? (
                  <View style={{ paddingVertical: 24, alignItems: "center" }}>
                    <Text style={{ fontSize: 32, marginBottom: 8 }}>🏋️</Text>
                    <Text style={{ color: Colors.textSecondary, fontSize: 13, textAlign: "center" }}>No sessions logged yet. Tap "Log Practice Session" to start tracking!</Text>
                  </View>
                ) : (
                  practiceSessions.map(s => {
                    const meta = SESSION_TYPE_META[s.sessionType] ?? { label: s.sessionType, icon: "🎯" };
                    const date = new Date(s.sessionDate).toLocaleDateString(getLocale(), { day: "numeric", month: "short", year: "2-digit" });
                    return (
                      <View key={s.id} style={{ flexDirection: "row", alignItems: "flex-start", paddingVertical: 12, borderBottomWidth: 1, borderColor: "rgba(255,255,255,0.06)" }}>
                        <Text style={{ fontSize: 22, marginRight: 10, marginTop: 1 }}>{meta.icon}</Text>
                        <View style={{ flex: 1 }}>
                          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                            <Text style={{ color: Colors.text, fontWeight: "700", fontSize: 13 }}>{meta.label}</Text>
                            {/* Task #1641 — distinguish tip-driven sessions
                                from manual ones so the cohort split is
                                visible to players, not just analytics. */}
                            {s.source === "coaching_tip" && (
                              <View
                                testID="practice-session-from-tip-badge"
                                style={{ backgroundColor: "rgba(251,191,36,0.15)", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 }}
                              >
                                <Text style={{ color: "#fbbf24", fontSize: 9, fontWeight: "700" }}>FROM COACHING TIP</Text>
                              </View>
                            )}
                          </View>
                          <View style={{ flexDirection: "row", gap: 12, marginTop: 2, flexWrap: "wrap" }}>
                            <Text style={{ color: Colors.textSecondary, fontSize: 11 }}>{date}</Text>
                            {s.durationMinutes && <Text style={{ color: Colors.textSecondary, fontSize: 11 }}>⏱ {s.durationMinutes}m</Text>}
                            {s.clubFocus && <Text style={{ color: Colors.primary, fontSize: 11 }}>{s.clubFocus}</Text>}
                            {s.practiceDistanceYards != null && (
                              <Text style={{ color: Colors.textSecondary, fontSize: 11 }}>{s.practiceDistanceYards} yds</Text>
                            )}
                          </View>
                          {s.notes && <Text style={{ color: Colors.textSecondary, fontSize: 11, marginTop: 3, opacity: 0.7 }} numberOfLines={2}>{s.notes}</Text>}
                        </View>
                        <TouchableOpacity onPress={() => deletePractice(s.id)} style={{ padding: 4 }}>
                          <Feather name="trash-2" size={14} color={Colors.textSecondary} />
                        </TouchableOpacity>
                      </View>
                    );
                  })
                )}
              </View>
            </>
          ) : tab === "prizes" ? (
            /* Prize Awards Tab */
            <>
              {prizeAwards.length === 0 ? (
                <View style={styles.empty}>
                  <Text style={{ fontSize: 40 }}>🏆</Text>
                  <Text style={styles.emptyTitle}>No prizes yet</Text>
                  <Text style={styles.emptyText}>Prize awards from your tournaments will appear here once assigned by the tournament administrator.</Text>
                </View>
              ) : (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>🏆 My Prize Awards ({prizeAwards.length})</Text>
                  {prizeAwards.map((award) => {
                    const sym: Record<string, string> = { INR: "₹", USD: "$", GBP: "£", EUR: "€", AED: "د.إ" };
                    const symbol = sym[award.currency] ?? award.currency;
                    return (
                      <View key={award.awardId} style={{ backgroundColor: Colors.surface, borderRadius: 14, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: "rgba(201,168,76,0.25)" }}>
                        <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" }}>
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: "#C9A84C", fontWeight: "800", fontSize: 15 }}>{award.categoryName}</Text>
                            <Text style={{ color: Colors.textSecondary, fontSize: 12, marginTop: 2 }}>{award.tournamentName}</Text>
                            {award.description ? <Text style={{ color: Colors.textSecondary, fontSize: 11, marginTop: 3 }}>{award.description}</Text> : null}
                            {award.notes ? <Text style={{ color: Colors.textSecondary, fontSize: 11, marginTop: 2, fontStyle: "italic" }}>{award.notes}</Text> : null}
                            <Text style={{ color: Colors.textSecondary, fontSize: 10, marginTop: 6, opacity: 0.6 }}>
                              {new Date(award.awardedAt).toLocaleDateString(getLocale(), { day: "numeric", month: "short", year: "numeric" })}
                            </Text>
                          </View>
                          {award.prizeValue != null && (
                            <Text style={{ color: "#C9A84C", fontWeight: "900", fontSize: 20, marginLeft: 12, minWidth: 60, textAlign: "right" }}>
                              {symbol}{award.prizeValue.toLocaleString()}
                            </Text>
                          )}
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}
            </>
          ) : tab === "handicap" ? (
            /* Handicap Calculator Tab */
            <HandicapSimulatorTab token={token} />
          ) : (
            /* Devices Tab */
            <>
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>⌚ Connected Devices</Text>
                {wearablesLoading ? (
                  <LoadingSpinner color={Colors.primary} style={{ marginVertical: 20 }} />
                ) : !wearables || wearables.length === 0 ? (
                  <Text style={styles.deviceNote}>No devices connected yet. Link a Garmin device or import a GPX file to enable shot tracking and Strokes Gained analysis.</Text>
                ) : (
                  wearables.map(w => {
                    const meta = PROVIDER_META[w.provider] ?? { label: w.provider, icon: "📱", description: "" };
                    return (
                      <View key={w.id} style={styles.deviceRow}>
                        <Text style={{ fontSize: 24, marginRight: 12 }}>{meta.icon}</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.deviceLabel}>{meta.label}</Text>
                          <Text style={styles.deviceSub}>{meta.description}</Text>
                          {w.updatedAt && (
                            <Text style={styles.deviceDate}>Last sync: {new Date(w.updatedAt).toLocaleDateString()}</Text>
                          )}
                        </View>
                        <View style={[styles.statusPill, w.status === "connected" ? styles.statusConnected : styles.statusDisc]}>
                          <Text style={styles.statusText}>{w.status === "connected" ? "Connected" : "Disconnected"}</Text>
                        </View>
                      </View>
                    );
                  })
                )}
              </View>

              <View style={styles.section}>
                <Text style={styles.sectionTitle}>🔗 Link Garmin</Text>
                <Text style={styles.deviceNote}>
                  Connect your Garmin GPS watch to auto-sync activities and enable Strokes Gained shot tracking. Requires your club to have Garmin integration enabled.
                </Text>
                <TouchableOpacity
                  style={styles.deviceBtn}
                  onPress={async () => {
                    try {
                      const data = await fetchPortal<{ url: string }>("/wearables/garmin/init", token);
                      if (data?.url) {
                        await Linking.openURL(data.url);
                      } else {
                        Alert.alert("Not Available", "Garmin integration is not enabled for your club. Contact your administrator.");
                      }
                    } catch {
                      Alert.alert("Error", "Could not start Garmin connection. Please try again.");
                    }
                  }}
                >
                  <Text style={styles.deviceBtnText}>⌚  Link Garmin Watch</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.section}>
                <Text style={styles.sectionTitle}>🗺️ Import GPX File</Text>
                <Text style={styles.deviceNote}>
                  Import a GPX file exported from any GPS device (Garmin Basecamp, Apple Watch export, etc.) to record your round's shot positions and enable Strokes Gained analysis.
                </Text>
                <TouchableOpacity
                  style={[styles.deviceBtn, styles.deviceBtnSecondary]}
                  onPress={() => Alert.alert("Import GPX", "GPX import is available on the web app. Visit your Player Portal on a browser, go to the Devices tab, and upload your GPX file from there.")}
                >
                  <Text style={[styles.deviceBtnText, styles.deviceBtnTextSecondary]}>🗺️  Import GPX File</Text>
                </TouchableOpacity>
              </View>

              {/* Apple Watch Companion */}
              <View style={styles.section}>
                <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
                  <Text style={styles.sectionTitle}>🍎 Apple Watch Companion</Text>
                  {watchStatus?.appleWatch && (
                    <View style={[styles.statusPill, watchStatus.appleWatch.connected ? styles.statusConnected : styles.statusDisc, { marginLeft: 10 }]}>
                      <Text style={styles.statusText}>{watchStatus.appleWatch.connected ? "Connected" : "Offline"}</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.deviceNote}>
                  Pair your Apple Watch to view live scores, leaderboard updates, and distance-to-pin directly on your wrist during a round.
                </Text>
                <View style={{ backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 12, padding: 14, marginTop: 8 }}>
                  <Text style={{ color: Colors.muted, fontSize: 11, marginBottom: 6 }}>PAIRING CODE (expires in 10 min)</Text>
                  <Text style={{ color: "#C9A84C", fontSize: 32, fontWeight: "800", letterSpacing: 6 }}>
                    {displayPairingCode ?? "------"}
                  </Text>
                  <Text style={{ color: Colors.muted, fontSize: 11, marginTop: 6 }}>
                    {displayPairingCode ? "Enter this code on your Apple Watch to pair." : "Tap 'Generate Code' to create a one-time pairing code."}
                  </Text>
                  <TouchableOpacity
                    onPress={generatePairingCode}
                    disabled={generatingCode}
                    style={{ marginTop: 10, paddingVertical: 8, paddingHorizontal: 14, backgroundColor: "rgba(201,168,76,0.15)", borderRadius: 8, borderColor: "rgba(201,168,76,0.3)", borderWidth: 1, alignSelf: "flex-start", opacity: generatingCode ? 0.6 : 1 }}
                  >
                    <Text style={{ color: "#C9A84C", fontSize: 12, fontWeight: "600" }}>{generatingCode ? "Generating..." : "Generate New Code"}</Text>
                  </TouchableOpacity>
                </View>
                <View style={{ marginTop: 10 }}>
                  <Text style={{ color: Colors.muted, fontSize: 12, fontWeight: "600", marginBottom: 6 }}>Watch Capabilities:</Text>
                  {(watchStatus?.capabilities ?? ["live_score", "leaderboard", "hole_scoring", "distance_to_pin", "shot_tracking"]).map(cap => (
                    <Text key={cap} style={{ color: Colors.text, fontSize: 12, marginBottom: 3 }}>
                      ✓  {cap.replace(/_/g, " ").replace(/\b\w/g, (l: string) => l.toUpperCase())}
                    </Text>
                  ))}
                </View>
                <TouchableOpacity
                  style={[styles.deviceBtn, { marginTop: 12 }]}
                  onPress={() => Alert.alert("Apple Watch", "Open the App Store on your Apple Watch and search for 'KHARAGOLF'. After installing, enter your pairing code shown above.")}
                >
                  <Text style={styles.deviceBtnText}>⌚  Install Watch App</Text>
                </TouchableOpacity>
              </View>

              {/* Wear OS Companion */}
              <View style={styles.section}>
                <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
                  <Text style={styles.sectionTitle}>🤖 Wear OS Companion</Text>
                  {watchStatus?.wearOS && (
                    <View style={[styles.statusPill, watchStatus.wearOS.connected ? styles.statusConnected : styles.statusDisc, { marginLeft: 10 }]}>
                      <Text style={styles.statusText}>{watchStatus.wearOS.connected ? "Connected" : "Offline"}</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.deviceNote}>
                  Pair your Wear OS watch (Samsung Galaxy Watch, Google Pixel Watch, etc.) to get live scoring and leaderboard on your wrist.
                </Text>
                <View style={{ backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 12, padding: 14, marginTop: 8 }}>
                  <Text style={{ color: Colors.muted, fontSize: 11, marginBottom: 6 }}>PAIRING CODE (expires in 10 min)</Text>
                  <Text style={{ color: "#4A9CF5", fontSize: 32, fontWeight: "800", letterSpacing: 6 }}>
                    {displayPairingCode ?? "------"}
                  </Text>
                  <Text style={{ color: Colors.muted, fontSize: 11, marginTop: 6 }}>
                    {displayPairingCode ? "Enter this code on your Wear OS watch to pair." : "Tap 'Generate Code' to create a one-time pairing code."}
                  </Text>
                  <TouchableOpacity
                    onPress={generatePairingCode}
                    disabled={generatingCode}
                    style={{ marginTop: 10, paddingVertical: 8, paddingHorizontal: 14, backgroundColor: "rgba(74,156,245,0.15)", borderRadius: 8, borderColor: "rgba(74,156,245,0.3)", borderWidth: 1, alignSelf: "flex-start", opacity: generatingCode ? 0.6 : 1 }}
                  >
                    <Text style={{ color: "#4A9CF5", fontSize: 12, fontWeight: "600" }}>{generatingCode ? "Generating..." : "Generate New Code"}</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity
                  style={[styles.deviceBtn, { marginTop: 12, backgroundColor: "rgba(74,156,245,0.15)", borderColor: "rgba(74,156,245,0.4)", borderWidth: 1 }]}
                  onPress={() => Alert.alert("Wear OS", "Open the Google Play Store on your Wear OS watch and search for 'KHARAGOLF'. After installing, enter your pairing code shown above.")}
                >
                  <Text style={[styles.deviceBtnText, { color: "#4A9CF5" }]}>🤖  Install Wear OS App</Text>
                </TouchableOpacity>
              </View>

              {/* Garmin Connect IQ Companion */}
              <View style={styles.section}>
                <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
                  <Text style={styles.sectionTitle}>⛳ Garmin Connect IQ</Text>
                  {watchStatus?.garminCiq && (
                    <View style={[styles.statusPill, watchStatus.garminCiq.connected ? styles.statusConnected : styles.statusDisc, { marginLeft: 10 }]}>
                      <Text style={styles.statusText}>{watchStatus.garminCiq.connected ? "Connected" : "Offline"}</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.deviceNote}>
                  Install the KHARAGOLF data field or app on your Garmin watch (Fenix, Forerunner, Venu, Approach, Epix) to see next-hole distance, PlaysLike, and live score on your wrist — and tap to log birdie / par / bogey.
                </Text>
                <View style={{ backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 12, padding: 14, marginTop: 8 }}>
                  <Text style={{ color: Colors.muted, fontSize: 11, marginBottom: 6 }}>PAIRING CODE (expires in 10 min)</Text>
                  <Text style={{ color: "#3CB371", fontSize: 32, fontWeight: "800", letterSpacing: 6 }}>
                    {displayPairingCode ?? "------"}
                  </Text>
                  <Text style={{ color: Colors.muted, fontSize: 11, marginTop: 6 }}>
                    {displayPairingCode ? "Open the KHARAGOLF Connect IQ app on your Garmin watch and enter this code." : "Tap 'Generate Code' to create a one-time pairing code."}
                  </Text>
                  <TouchableOpacity
                    onPress={generatePairingCode}
                    disabled={generatingCode}
                    style={{ marginTop: 10, paddingVertical: 8, paddingHorizontal: 14, backgroundColor: "rgba(60,179,113,0.15)", borderRadius: 8, borderColor: "rgba(60,179,113,0.4)", borderWidth: 1, alignSelf: "flex-start", opacity: generatingCode ? 0.6 : 1 }}
                  >
                    <Text style={{ color: "#3CB371", fontSize: 12, fontWeight: "600" }}>{generatingCode ? "Generating..." : "Generate New Code"}</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity
                  style={[styles.deviceBtn, { marginTop: 12, backgroundColor: "rgba(60,179,113,0.15)", borderColor: "rgba(60,179,113,0.4)", borderWidth: 1 }]}
                  onPress={() => Alert.alert("Garmin Connect IQ", "Open the Connect IQ Store on your phone (Garmin Connect app → Connect IQ Store) and search for 'KHARAGOLF'. Install both the data field and the app, then enter the pairing code shown above on your watch.")}
                >
                  <Text style={[styles.deviceBtnText, { color: "#3CB371" }]}>⛳  Install Garmin App</Text>
                </TouchableOpacity>
              </View>

              <HrHealthSection token={token ?? null} />

              {stats?.strokesGained && stats.strokesGained.trackedRounds >= 5 && (
                <View style={styles.section}>
                  <Text style={styles.sectionTitle}>
                    ⚡ Strokes Gained vs {stats.strokesGained.baseline === "scratch" ? "Tour" : `${stats.strokesGained.baseline}-hcp`}
                  </Text>
                  <View style={styles.row4}>
                    {[
                      { label: "Putting", value: stats.strokesGained.sgPutting },
                      { label: "Approach", value: stats.strokesGained.sgApproach },
                      { label: "ATG", value: stats.strokesGained.sgATG },
                      { label: "OTT", value: stats.strokesGained.sgOffTheTee },
                      { label: "Total", value: stats.strokesGained.sgTotal },
                    ].map(sg => (
                      <View key={sg.label} style={styles.sgCell}>
                        <Text style={[styles.sgVal, sg.value !== null && sg.value >= 0 ? styles.sgPos : styles.sgNeg]}>
                          {sg.value !== null ? `${sg.value >= 0 ? "+" : ""}${sg.value.toFixed(2)}` : "—"}
                        </Text>
                        <Text style={styles.approachLabel}>{sg.label}</Text>
                      </View>
                    ))}
                  </View>
                  <Text style={styles.sgNote}>{stats.strokesGained.trackedRounds} rounds tracked · positive = above baseline</Text>
                  {(stats.strokesGained.sgPuttingMeasuredRounds !== undefined || stats.strokesGained.sgPuttingEstimatedRounds !== undefined) && (
                    (stats.strokesGained.sgPuttingMeasuredRounds ?? 0) + (stats.strokesGained.sgPuttingEstimatedRounds ?? 0) > 0 ? (
                      <Text style={styles.sgNote}>
                        SG-Putting split: {stats.strokesGained.sgPuttingMeasuredRounds ?? 0} measured · {stats.strokesGained.sgPuttingEstimatedRounds ?? 0} estimated
                      </Text>
                    ) : null
                  )}
                </View>
              )}
            </>
          )}
        </ScrollView>
      )}

      {/* Round Viewer Modal */}
      <Modal visible={!!selectedRound} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { setSelectedRound(null); setReplayMode(false); setReplayData([]); }}>
        <View style={{ flex: 1, backgroundColor: Colors.background }}>
          {/* Modal header */}
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12, borderBottomWidth: 1, borderColor: "rgba(255,255,255,0.08)" }}>
            <Pressable onPress={() => { setSelectedRound(null); setReplayMode(false); setReplayData([]); }} style={{ marginRight: 12 }}>
              <Feather name="x" size={22} color={Colors.muted} />
            </Pressable>
            <View style={{ flex: 1 }}>
              <Text style={{ color: Colors.text, fontSize: 16, fontWeight: "700" }}>
                {roundDetail ? roundDetail.tournament.name : "Round Scorecard"}
              </Text>
              {roundDetail && (
                <Text style={{ color: Colors.muted, fontSize: 12, marginTop: 1 }}>
                  {roundDetail.player.firstName} {roundDetail.player.lastName} · HCP {roundDetail.player.handicapIndex ?? "N/A"} · {roundDetail.player.teeBox}
                </Text>
              )}
            </View>
            {replayMode && replayData[replayHole] && (
              <Pressable onPress={saveReplayImage} disabled={saveLoading} style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: "rgba(201,168,76,0.4)", backgroundColor: "rgba(201,168,76,0.1)", marginRight: 8 }}>
                {saveLoading ? <LoadingSpinner size="small" color="#C9A84C" /> : <Feather name="download" size={14} color="#C9A84C" />}
                <Text style={{ color: "#C9A84C", fontSize: 12, fontWeight: "700" }}>Save</Text>
              </Pressable>
            )}
            <Pressable onPress={shareRound} style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: "rgba(201,168,76,0.4)", backgroundColor: "rgba(201,168,76,0.1)" }}>
              {shareLoading ? <LoadingSpinner size="small" color="#C9A84C" /> : <Feather name="share-2" size={14} color="#C9A84C" />}
              <Text style={{ color: "#C9A84C", fontSize: 12, fontWeight: "700" }}>Share</Text>
            </Pressable>
          </View>

          {/* Mode switcher inside modal */}
          <View style={{ flexDirection: "row", marginHorizontal: 16, marginTop: 10, borderRadius: 10, overflow: "hidden", backgroundColor: "rgba(255,255,255,0.06)", gap: 2, padding: 3 }}>
            <TouchableOpacity onPress={() => setReplayMode(false)} style={{ flex: 1, paddingVertical: 7, alignItems: "center", borderRadius: 8, backgroundColor: !replayMode ? "rgba(201,168,76,0.2)" : "transparent" }}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: !replayMode ? "#C9A84C" : Colors.muted }}>Scorecard</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => { setReplayMode(true); if (selectedRound && !replayLoading && replayData.length === 0) fetchReplay(selectedRound); }}
              style={{ flex: 1, paddingVertical: 7, alignItems: "center", borderRadius: 8, backgroundColor: replayMode ? "rgba(201,168,76,0.2)" : "transparent" }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: replayMode ? "#C9A84C" : Colors.muted }}>🗺️ Shot Replay</Text>
            </TouchableOpacity>
          </View>

          {replayMode ? (
            /* Shot Replay view */
            <View style={{ flex: 1 }}>
              {replayLoading ? (
                <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                  <LoadingSpinner color={Colors.primary} />
                  <Text style={{ color: Colors.muted, marginTop: 10 }}>Loading shot data…</Text>
                </View>
              ) : replayData.length === 0 ? (
                <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 }}>
                  <Text style={{ fontSize: 36, marginBottom: 12 }}>🗺️</Text>
                  <Text style={{ color: Colors.text, fontSize: 16, fontWeight: "700", marginBottom: 8 }}>No shot data available</Text>
                  <Text style={{ color: Colors.muted, textAlign: "center", fontSize: 13 }}>Connect a GPS wearable or upload a GPX file to track shots hole by hole.</Text>
                </View>
              ) : (() => {
                const hrBaselineForFilter = replayHr?.baselineHrBpm ?? null;
                const stressHoleNumbers = new Set<number>();
                if (hrBaselineForFilter != null && replayHr) {
                  for (const h of replayHr.holes) {
                    if ((h.avgHr - hrBaselineForFilter) >= stressThreshold || (h.maxHr - hrBaselineForFilter) >= stressThreshold) {
                      stressHoleNumbers.add(h.holeNumber);
                    }
                  }
                }
                const filterAvailable = hrBaselineForFilter != null && replayHr != null && replayHr.holes.length > 0;
                const stressFilterActive = stressOnly && filterAvailable;
                const stressHolesWithShots = replayData.filter(h => stressHoleNumbers.has(h.hole));
                const visibleHoles = stressFilterActive ? stressHolesWithShots : replayData;
                const safeHoleIdx = Math.min(replayHole, Math.max(visibleHoles.length - 1, 0));
                const stressCount = stressHolesWithShots.length;
                return (
                <View style={{ flex: 1 }}>
                  {/* Stress filter toggle */}
                  <View style={{ marginHorizontal: 16, marginTop: 10, padding: 12, backgroundColor: "rgba(239,68,68,0.06)", borderRadius: 10, borderWidth: 1, borderColor: "rgba(239,68,68,0.18)" }}>
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                      <View style={{ flex: 1, paddingRight: 10 }}>
                        <Text style={{ color: Colors.text, fontSize: 13, fontWeight: "700" }}>❤️ Stress holes only</Text>
                        <Text style={{ color: Colors.muted, fontSize: 11, marginTop: 2 }}>
                          {!filterAvailable
                            ? "Needs a baseline HR and recorded samples for this round."
                            : `${stressCount} stress hole${stressCount === 1 ? "" : "s"} above baseline +${stressThreshold} bpm`}
                        </Text>
                      </View>
                      <Switch
                        value={stressFilterActive}
                        onValueChange={v => { setStressOnly(v); setReplayHole(0); }}
                        disabled={!filterAvailable}
                        trackColor={{ false: "rgba(255,255,255,0.12)", true: "#ef4444" }}
                        thumbColor="#fff"
                      />
                    </View>
                    {filterAvailable && stressFilterActive && (
                      <View style={{ flexDirection: "row", alignItems: "center", marginTop: 10, gap: 10 }}>
                        <Text style={{ color: Colors.muted, fontSize: 11, fontWeight: "600" }}>Threshold</Text>
                        <TouchableOpacity
                          onPress={() => { setStressThreshold(t => Math.max(5, t - 5)); setReplayHole(0); }}
                          style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center" }}
                        >
                          <Text style={{ color: Colors.text, fontSize: 16, lineHeight: 18 }}>−</Text>
                        </TouchableOpacity>
                        <Text style={{ color: "#ef4444", fontSize: 13, fontWeight: "800", minWidth: 60, textAlign: "center" }}>+{stressThreshold} bpm</Text>
                        <TouchableOpacity
                          onPress={() => { setStressThreshold(t => Math.min(50, t + 5)); setReplayHole(0); }}
                          style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center" }}
                        >
                          <Text style={{ color: Colors.text, fontSize: 16, lineHeight: 18 }}>+</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>

                  {/* Hole nav — flex-wrap grid, no horizontal scroll */}
                  {visibleHoles.length === 0 ? (
                    <View style={{ alignItems: "center", justifyContent: "center", paddingHorizontal: 32, paddingVertical: 40 }}>
                      <Text style={{ fontSize: 32, marginBottom: 10 }}>😌</Text>
                      <Text style={{ color: Colors.text, fontSize: 14, fontWeight: "700", marginBottom: 6 }}>No stress holes</Text>
                      <Text style={{ color: Colors.muted, textAlign: "center", fontSize: 12 }}>
                        Your heart rate stayed within +{stressThreshold} bpm of baseline on every hole. Lower the threshold or turn the filter off to see all holes.
                      </Text>
                    </View>
                  ) : (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 16, paddingVertical: 10, gap: 6 }}>
                    {visibleHoles.map((h, i) => (
                      <TouchableOpacity key={h.hole} onPress={() => setReplayHole(i)}
                        style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: safeHoleIdx === i ? Colors.primary : "rgba(255,255,255,0.08)" }}>
                        <Text style={{ fontSize: 12, fontWeight: "700", color: safeHoleIdx === i ? "#fff" : Colors.muted }}>{h.hole}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  )}

                  {/* SVG Diagram */}
                  {visibleHoles[safeHoleIdx] && (() => {
                    const hd = visibleHoles[safeHoleIdx];
                    const shots = hd.shots;
                    const W = 280, H = 360, PAD = 28;
                    const hasDist = shots.some(s => s.distanceToPin !== null);

                    let pts: Array<{ x: number; y: number; s: typeof shots[0] }> = [];
                    const maxDistVal = Math.max(...shots.map(s => parseFloat(s.distanceToPin ?? "0") || 0), 1);
                    if (hasDist) {
                      pts = shots.map((s, i) => {
                        const angle = (i / Math.max(shots.length - 1, 1)) * Math.PI * 0.5 - Math.PI * 0.25;
                        const dist = parseFloat(s.distanceToPin ?? "0") || 0;
                        const r = (dist / maxDistVal) * (H * 0.6);
                        return { x: W / 2 + Math.sin(angle) * r * 0.55, y: H - PAD - r, s };
                      });
                    } else {
                      pts = shots.map((s, i) => ({
                        x: PAD + (i / Math.max(shots.length - 1, 1)) * (W - PAD * 2),
                        y: H / 2,
                        s,
                      }));
                    }

                    const COLORS: Record<string, string> = { tee: "#C9A84C", approach: "#3B82F6", chip: "#10B981", putt: "#A855F7", penalty: "#EF4444", other: "#6B7280" };

                    const hrBaseline = replayHr?.baselineHrBpm ?? null;
                    const hrShotsForHole = replayHr?.shots.find(g => g.holeNumber === hd.hole)?.shots ?? [];
                    const hrByShot = new Map<number, { hrBpm: number; delta: number | null }>();
                    hrShotsForHole.forEach(hs => {
                      if (hs.hrBpm == null || hs.shotNumber == null) return;
                      hrByShot.set(hs.shotNumber, {
                        hrBpm: hs.hrBpm,
                        delta: hrBaseline != null ? hs.hrBpm - hrBaseline : null,
                      });
                    });
                    const lookupHr = (i: number) => {
                      const sn = shots[i].shotNumber ?? (i + 1);
                      return hrByShot.get(sn) ?? null;
                    };

                    return (
                      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, gap: 12 }}>
                        <View ref={replayShotRef} collapsable={false} style={{ backgroundColor: "#0a1f14", borderRadius: 12, padding: 12, gap: 8 }}>
                          <Text style={{ color: Colors.text, fontWeight: "700", fontSize: 15 }}>Hole {hd.hole} · {shots.length} shot{shots.length !== 1 ? "s" : ""}</Text>
                          <Text style={{ color: Colors.muted, fontSize: 11 }}>
                            {hrBaseline != null
                              ? `HR baseline: ${hrBaseline} bpm — badges show beats above/below baseline`
                              : "HR baseline: not set — badges show raw heart rate"}
                          </Text>
                          <Svg width={W} height={H} style={{ borderRadius: 12, backgroundColor: "rgba(0,50,20,0.4)" }}>
                          {/* Green */}
                          <Circle cx={W / 2} cy={PAD + 18} r={22} fill="rgba(0,160,50,0.3)" />
                          {/* Flag */}
                          <SvgLine x1={W / 2} y1={PAD + 14} x2={W / 2} y2={PAD + 2} stroke="#fff" strokeWidth={1.5} />
                          <Circle cx={W / 2} cy={PAD + 14} r={3} fill="#EF4444" />
                          {/* Paths */}
                          {pts.length > 1 && pts.slice(1).map((pt, i) => (
                            <SvgLine key={i} x1={pts[i].x} y1={pts[i].y} x2={pt.x} y2={pt.y} stroke="rgba(255,255,255,0.2)" strokeWidth={1.5} strokeDasharray="4 3" />
                          ))}
                          {/* Shot circles */}
                          {pts.map((pt, i) => {
                            const hr = lookupHr(i);
                            const typeColor = COLORS[pt.s.shotType ?? "other"] ?? "#6B7280";
                            const fillColor = hr ? hrColor(hr.hrBpm, hrBaseline) : typeColor;
                            return (
                              <React.Fragment key={i}>
                                <Circle cx={pt.x} cy={pt.y} r={11} fill={fillColor} fillOpacity={0.18} />
                                <Circle cx={pt.x} cy={pt.y} r={8} fill={fillColor} stroke={hr ? typeColor : "none"} strokeWidth={hr ? 1.5 : 0} />
                                <SvgText x={pt.x} y={pt.y + 1} textAnchor="middle" dominantBaseline="middle" fontSize={9} fontWeight="bold" fill="#fff">{i + 1}</SvgText>
                                {hr ? (
                                  <SvgText x={pt.x} y={pt.y + 22} textAnchor="middle" fontSize={9} fontWeight="700" fill={fillColor}>
                                    ♥ {hr.hrBpm}{hr.delta != null ? ` ${hr.delta >= 0 ? "+" : ""}${hr.delta}` : ""}
                                  </SvgText>
                                ) : null}
                              </React.Fragment>
                            );
                          })}
                          </Svg>
                        </View>
                        {/* Shot legend */}
                        {shots.map((s, i) => {
                          const color = COLORS[s.shotType ?? "other"] ?? "#6B7280";
                          const hr = lookupHr(i);
                          const hrFill = hr ? hrColor(hr.hrBpm, hrBaseline) : null;
                          return (
                            <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                              <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: color, alignItems: "center", justifyContent: "center" }}>
                                <Text style={{ fontSize: 10, fontWeight: "700", color: "#fff" }}>{i + 1}</Text>
                              </View>
                              <View style={{ flex: 1 }}>
                                <Text style={{ color: Colors.text, fontSize: 13, fontWeight: "600" }}>{s.club ?? s.shotType ?? `Shot ${i + 1}`}</Text>
                                <View style={{ flexDirection: "row", gap: 12 }}>
                                  {s.distanceCarried && <Text style={{ color: Colors.muted, fontSize: 11 }}>Carry: {parseFloat(s.distanceCarried).toFixed(0)} yds</Text>}
                                  {s.distanceToPin && <Text style={{ color: Colors.muted, fontSize: 11 }}>To pin: {parseFloat(s.distanceToPin).toFixed(0)} yds</Text>}
                                </View>
                              </View>
                              {hr && hrFill ? (
                                <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, backgroundColor: hrFill + "26", borderWidth: 1, borderColor: hrFill + "66" }}>
                                  <Text style={{ fontSize: 11, color: hrFill, fontWeight: "800" }}>♥ {hr.hrBpm}</Text>
                                  {hr.delta != null ? (
                                    <Text style={{ fontSize: 10, color: hrFill, fontWeight: "700" }}>
                                      {hr.delta >= 0 ? "+" : ""}{hr.delta}
                                    </Text>
                                  ) : null}
                                </View>
                              ) : null}
                            </View>
                          );
                        })}
                      </ScrollView>
                    );
                  })()}
                </View>
                );
              })()}
            </View>
          ) : roundDetailLoading ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <LoadingSpinner size="large" color={Colors.primary} />
              <Text style={{ color: Colors.muted, marginTop: 12 }}>Loading scorecard…</Text>
            </View>
          ) : !roundDetail ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <Feather name="alert-circle" size={36} color={Colors.muted} />
              <Text style={{ color: Colors.muted, marginTop: 10 }}>No hole-by-hole data available.</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }} showsVerticalScrollIndicator={false}>
              {(roundDetail.rounds ?? []).map(rd => {
                const roundNum = selectedRound?.round ?? 1;
                if (rd.round !== roundNum) return null;
                const scorecardHrBaseline = replayHr?.baselineHrBpm ?? null;
                const scorecardStressHoles = new Set<number>();
                if (scorecardHrBaseline != null && replayHr) {
                  for (const hh of replayHr.holes) {
                    if ((hh.avgHr - scorecardHrBaseline) >= stressThreshold || (hh.maxHr - scorecardHrBaseline) >= stressThreshold) {
                      scorecardStressHoles.add(hh.holeNumber);
                    }
                  }
                }
                return (
                  <View key={rd.round}>
                    {/* Round summary */}
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                      <Text style={{ color: Colors.text, fontSize: 15, fontWeight: "700" }}>Round {rd.round}</Text>
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        {rd.fairwayPct != null && <Text style={{ color: Colors.muted, fontSize: 11 }}>FW {rd.fairwayPct}%</Text>}
                        {rd.girPct != null && <Text style={{ color: Colors.muted, fontSize: 11 }}>GIR {rd.girPct}%</Text>}
                        {rd.totalPutts != null && <Text style={{ color: Colors.muted, fontSize: 11 }}>{rd.totalPutts} putts</Text>}
                        <View style={{ paddingHorizontal: 10, paddingVertical: 3, borderRadius: 12, backgroundColor: toParBg(rd.toPar), borderWidth: 1, borderColor: toParColor(rd.toPar) + "40" }}>
                          <Text style={{ color: toParColor(rd.toPar), fontSize: 13, fontWeight: "800" }}>
                            {rd.gross} ({rd.toPar === 0 ? "E" : rd.toPar > 0 ? `+${rd.toPar}` : `${rd.toPar}`})
                          </Text>
                        </View>
                      </View>
                    </View>

                    {/* Hole grid */}
                    <View style={{ borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: "rgba(255,255,255,0.08)" }}>
                      {/* Header */}
                      <View style={{ flexDirection: "row", backgroundColor: "#0a1a0f", paddingVertical: 6 }}>
                        <Text style={{ flex: 2, color: "#C9A84C", fontSize: 10, fontWeight: "700", paddingLeft: 10 }}>HOLE</Text>
                        <Text style={{ flex: 1, color: "#C9A84C", fontSize: 10, fontWeight: "700", textAlign: "center" }}>PAR</Text>
                        <Text style={{ flex: 1, color: "#C9A84C", fontSize: 10, fontWeight: "700", textAlign: "center" }}>SCORE</Text>
                        <Text style={{ flex: 1, color: "#C9A84C", fontSize: 10, fontWeight: "700", textAlign: "center" }}>±PAR</Text>
                      </View>
                      {[...rd.holes].sort((a, b) => a.holeNumber - b.holeNumber).map((h, idx) => (
                        <View key={h.holeNumber} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 7, backgroundColor: idx % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent", borderTopWidth: 1, borderColor: "rgba(255,255,255,0.04)" }}>
                          <View style={{ flex: 2, flexDirection: "row", alignItems: "center", paddingLeft: 10, gap: 6 }}>
                            <Text style={{ color: Colors.muted, fontSize: 13 }}>{h.holeNumber}</Text>
                            {scorecardStressHoles.has(h.holeNumber) ? (
                              <Text
                                accessibilityLabel={`Stress hole: heart rate above baseline +${stressThreshold} bpm`}
                                style={{ color: "#ef4444", fontSize: 12, fontWeight: "800" }}
                              >
                                ♥
                              </Text>
                            ) : null}
                          </View>
                          <Text style={{ flex: 1, color: Colors.textSecondary, fontSize: 13, textAlign: "center" }}>{h.par}</Text>
                          <View style={{ flex: 1, alignItems: "center" }}>
                            <View style={{ width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: toParBg(h.toPar) }}>
                              <Text style={{ color: toParColor(h.toPar), fontSize: 12, fontWeight: "800" }}>{h.strokes}</Text>
                            </View>
                          </View>
                          <Text style={{ flex: 1, color: toParColor(h.toPar), fontSize: 12, fontWeight: "700", textAlign: "center" }}>
                            {h.toPar === 0 ? "E" : h.toPar > 0 ? `+${h.toPar}` : `${h.toPar}`}
                          </Text>
                        </View>
                      ))}
                      {/* Total row */}
                      <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 8, backgroundColor: "rgba(201,168,76,0.06)", borderTopWidth: 1, borderColor: "rgba(201,168,76,0.3)" }}>
                        <Text style={{ flex: 2, color: "#C9A84C", fontSize: 12, fontWeight: "700", paddingLeft: 10 }}>TOTAL</Text>
                        <Text style={{ flex: 1, color: Colors.textSecondary, fontSize: 12, fontWeight: "700", textAlign: "center" }}>{rd.holes.reduce((a, h) => a + h.par, 0)}</Text>
                        <Text style={{ flex: 1, color: "#C9A84C", fontSize: 14, fontWeight: "800", textAlign: "center" }}>{rd.gross}</Text>
                        <Text style={{ flex: 1, color: toParColor(rd.toPar), fontSize: 12, fontWeight: "800", textAlign: "center" }}>
                          {rd.toPar === 0 ? "E" : rd.toPar > 0 ? `+${rd.toPar}` : `${rd.toPar}`}
                        </Text>
                      </View>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
  headerTitle: { fontSize: 28, fontWeight: "800", color: Colors.text, letterSpacing: -0.5 },
  headerSub: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  tabsBar: {
    flexDirection: "row",
    borderBottomWidth: 1, borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  tabBtn: {
    flex: 1, paddingVertical: 12, alignItems: "center",
    borderBottomWidth: 2, borderBottomColor: "transparent",
  },
  tabBtnActive: { borderBottomColor: Colors.primary },
  tabText: { fontSize: 12, color: Colors.muted, fontFamily: "Inter_500Medium" },
  tabTextActive: { color: Colors.primary, fontFamily: "Inter_600SemiBold" },
  // Stats "More" bottom sheet
  moreBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  moreSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 16, paddingBottom: 40,
    borderTopWidth: 1, borderColor: Colors.border,
  },
  modalHandle: {
    width: 36, height: 4, borderRadius: 2, backgroundColor: Colors.border,
    alignSelf: "center", marginTop: 12, marginBottom: 4,
  },
  moreSheetTitle: { fontFamily: "Inter_700Bold", fontSize: 17, color: Colors.text, paddingVertical: 14, textAlign: "center" },
  moreItem: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Colors.border + "60",
  },
  moreItemActive: {},
  moreItemLabel: { fontFamily: "Inter_600SemiBold", fontSize: 16, color: Colors.text },
  moreItemDesc: { fontFamily: "Inter_400Regular", fontSize: 12, color: Colors.muted, marginTop: 2 },
  // Hole Averages toggle
  holeToggle: {
    flexDirection: "row", backgroundColor: Colors.card, borderRadius: 8, padding: 2, gap: 2,
  },
  holeToggleBtn: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 6 },
  holeToggleBtnActive: { backgroundColor: Colors.primary + "30" },
  holeToggleBtnText: { fontFamily: "Inter_500Medium", fontSize: 12, color: Colors.muted },
  holeToggleBtnTextActive: { color: Colors.primary, fontFamily: "Inter_600SemiBold" },
  scroll: { flex: 1 },
  section: { marginHorizontal: 16, marginTop: 16, backgroundColor: Colors.surface, borderRadius: 16, padding: 16 },
  sectionTitle: { fontSize: 14, fontWeight: "700", color: Colors.text, marginBottom: 12 },
  statGrid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: 12, marginTop: 12, gap: 8 },
  statCard: { width: "47.5%", backgroundColor: Colors.surface, borderRadius: 14, padding: 14, alignItems: "center", gap: 4 },
  statValue: { fontSize: 24, fontWeight: "800" },
  statLabel: { fontSize: 11, color: Colors.textSecondary, fontWeight: "600" },
  barRow: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
  barLabel: { width: 80, fontSize: 12, color: Colors.textSecondary },
  barTrack: { flex: 1, height: 8, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 4, overflow: "hidden" },
  barFill: { height: 8, borderRadius: 4 },
  barCount: { width: 28, textAlign: "right", fontSize: 12, color: Colors.text, fontWeight: "700" },
  roundBar: { flexDirection: "row", alignItems: "center", marginBottom: 6 },
  roundBarLabel: { width: 24, fontSize: 11, color: Colors.textSecondary },
  roundBarTrack: { flex: 1, height: 10, backgroundColor: "rgba(255,255,255,0.1)", borderRadius: 5, overflow: "hidden", marginHorizontal: 8 },
  roundBarFill: { height: 10, borderRadius: 5 },
  roundBarValue: { width: 32, textAlign: "right", fontSize: 12, fontWeight: "700" },
  row3: { flexDirection: "row" },
  approach: { flex: 1, alignItems: "center", paddingVertical: 8 },
  approachBorder: { borderLeftWidth: 1, borderRightWidth: 1, borderColor: "rgba(255,255,255,0.1)" },
  approachVal: { fontSize: 22, fontWeight: "800", color: Colors.text },
  approachLabel: { fontSize: 11, color: Colors.textSecondary, marginTop: 2 },
  holeRow: { flexDirection: "row", marginBottom: 6 },
  holeCell: { width: 32, textAlign: "center", fontSize: 11, color: Colors.textSecondary },
  holeLabelCell: { width: 36, textAlign: "left", color: Colors.textSecondary, fontWeight: "600" },
  badgeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  badge: { width: "30%", backgroundColor: "rgba(255,255,255,0.05)", borderRadius: 14, padding: 12, alignItems: "center", gap: 4, borderWidth: 1, borderColor: "rgba(255,255,255,0.1)" },
  badgeLabel: { fontSize: 10, color: Colors.text, fontWeight: "700", textAlign: "center" },
  badgeDate: { fontSize: 9, color: Colors.textSecondary },
  empty: { alignItems: "center", paddingTop: 60, paddingHorizontal: 32, gap: 12 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: Colors.text },
  emptyText: { fontSize: 13, color: Colors.textSecondary, textAlign: "center" },
  row4: { flexDirection: "row" },
  sgCell: { flex: 1, alignItems: "center", paddingVertical: 8, borderLeftWidth: 0 },
  sgVal: { fontSize: 18, fontWeight: "800" },
  sgPos: { color: "#22c55e" },
  sgNeg: { color: "#ef4444" },
  sgNote: { fontSize: 10, color: Colors.textSecondary, marginTop: 6, textAlign: "center" },
  periodRow: { flexDirection: "row", paddingHorizontal: 16, paddingVertical: 10, gap: 8 },
  periodChip: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20, borderWidth: 1, borderColor: "rgba(255,255,255,0.15)" },
  periodChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  periodChipText: { fontSize: 12, color: Colors.textSecondary },
  periodChipTextActive: { color: "#fff", fontWeight: "600" },
  deviceRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: 1, borderColor: "rgba(255,255,255,0.08)" },
  deviceLabel: { fontSize: 14, fontWeight: "700", color: Colors.text },
  deviceSub: { fontSize: 11, color: Colors.textSecondary, marginTop: 1 },
  deviceDate: { fontSize: 10, color: Colors.textSecondary, marginTop: 2, opacity: 0.7 },
  deviceNote: { fontSize: 12, color: Colors.textSecondary, lineHeight: 18, marginBottom: 12 },
  deviceBtn: { backgroundColor: Colors.primary, borderRadius: 12, paddingVertical: 12, alignItems: "center", marginTop: 4 },
  deviceBtnSecondary: { backgroundColor: "transparent", borderWidth: 1, borderColor: Colors.primary },
  deviceBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  deviceBtnTextSecondary: { color: Colors.primary },
  statusPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  statusConnected: { backgroundColor: "rgba(34,197,94,0.15)" },
  statusDisc: { backgroundColor: "rgba(239,68,68,0.15)" },
  statusText: { fontSize: 11, fontWeight: "700", color: "#22c55e" },
});
