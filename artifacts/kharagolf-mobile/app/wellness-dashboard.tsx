import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Line, Path, Text as SvgText } from "react-native-svg";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";

const TRAILING_WINDOW_OPTIONS = [3, 5, 10, 20] as const;
type TrailingWindowOption = (typeof TRAILING_WINDOW_OPTIONS)[number];
const DEFAULT_TRAILING_WINDOW: TrailingWindowOption = 5;
const trailingWindowStorageKey = (userId: string | number | undefined) =>
  `kharagolf_wellness_trailing_window_${userId ?? "anon"}`;
// Task #946 — one-shot flag set after we have either pushed the user's local
// cached preference to the server or confirmed that the server already has a
// value. Prevents the legacy AsyncStorage value from being re-uploaded on every
// app launch (which would otherwise clobber a more recent choice the user
// made on another device).
const trailingWindowSyncedKey = (userId: string | number | undefined) =>
  `kharagolf_wellness_trailing_window_synced_${userId ?? "anon"}`;

// Task #1091 — same persistence pattern, applied to the 30/60/90-day visible
// range selector. Cached locally per-user so the screen can render before the
// network round-trip completes (and so offline launches retain the choice),
// then reconciled with the server-side value on every load.
const RANGE_OPTIONS = [30, 60, 90] as const;
const DEFAULT_RANGE: RangeOption = 30;
const rangeStorageKey = (userId: string | number | undefined) =>
  `kharagolf_wellness_range_days_${userId ?? "anon"}`;
const rangeSyncedKey = (userId: string | number | undefined) =>
  `kharagolf_wellness_range_days_synced_${userId ?? "anon"}`;

const BASE_URL = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : "";

type WellnessDay = {
  metricDate: string;
  readinessScore: number | null;
  sleepMinutes: number | null;
  sleepScore: number | null;
  hrvMs: number | null;
  restingHr: number | null;
  steps: number | null;
  sources: string[];
};

type HandicapPoint = {
  handicapIndex: number;
  recordedAt: string | null;
};

type ScoringPoint = {
  scoringAvg: number;
  recordedAt: string | null;
  roundsInWindow?: number;
};

type OverlayMode = "handicap" | "scoring";

type OverlayPoint = { value: number; recordedAt: string | null };

const HANDICAP_COLOR = "#f59e0b";
const SCORING_COLOR = "#06b6d4";

type RangeOption = 30 | 60 | 90;

type MetricKey = "readinessScore" | "sleepMinutes" | "hrvMs" | "restingHr";

type MetricSpec = {
  key: MetricKey;
  title: string;
  unit: string;
  color: string;
  formatValue: (n: number) => string;
  yMin?: number;
  yMax?: number;
};

const METRICS: MetricSpec[] = [
  {
    key: "readinessScore",
    title: "Readiness",
    unit: "/100",
    color: "#22c55e",
    formatValue: (n) => `${Math.round(n)}`,
    yMin: 0,
    yMax: 100,
  },
  {
    key: "sleepMinutes",
    title: "Sleep duration",
    unit: "hours",
    color: "#3b82f6",
    formatValue: (n) => `${(n / 60).toFixed(1)}h`,
    yMin: 0,
  },
  {
    key: "hrvMs",
    title: "HRV",
    unit: "ms",
    color: "#a855f7",
    formatValue: (n) => `${Math.round(n)} ms`,
  },
  {
    key: "restingHr",
    title: "Resting heart rate",
    unit: "bpm",
    color: "#ef4444",
    formatValue: (n) => `${Math.round(n)} bpm`,
  },
];

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

interface ChartProps {
  series: WellnessDay[];
  metric: MetricSpec;
  width: number;
  overlayPoints?: OverlayPoint[];
  overlayColor?: string;
  overlayValueFormatter?: (n: number) => string;
}

function MetricChart({
  series,
  metric,
  width,
  overlayPoints,
  overlayColor = HANDICAP_COLOR,
  overlayValueFormatter,
}: ChartProps) {
  const height = 180;
  const padLeft = 36;
  const padRight = 12;
  const padTop = 12;
  const padBottom = 24;
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;

  // Series comes newest-first; chart oldest-left.
  const ordered = useMemo(() => series.slice().reverse(), [series]);
  const points = ordered.map((d) => {
    const v = d[metric.key];
    return typeof v === "number" ? v : null;
  });
  const presentValues = points.filter((v): v is number => v != null);

  if (presentValues.length === 0) {
    return (
      <View style={[styles.chartEmpty, { width, height }]}>
        <Text style={styles.chartEmptyText}>No data in this range</Text>
      </View>
    );
  }

  let yMin = metric.yMin ?? Math.min(...presentValues);
  let yMax = metric.yMax ?? Math.max(...presentValues);
  if (yMin === yMax) {
    // Avoid divide by zero — pad +/-1.
    yMin = yMin - 1;
    yMax = yMax + 1;
  } else if (metric.yMin == null && metric.yMax == null) {
    const span = yMax - yMin;
    yMin = yMin - span * 0.1;
    yMax = yMax + span * 0.1;
  }

  const xFor = (i: number) =>
    padLeft + (ordered.length === 1 ? innerW / 2 : (i / (ordered.length - 1)) * innerW);
  const yFor = (v: number) => padTop + (1 - (v - yMin) / (yMax - yMin)) * innerH;

  // Build a path that lifts the pen over null gaps.
  let d = "";
  let penDown = false;
  points.forEach((v, i) => {
    if (v == null) {
      penDown = false;
      return;
    }
    const x = xFor(i);
    const y = yFor(v);
    d += `${penDown ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)} `;
    penDown = true;
  });

  const ticks = 4;
  const tickValues = Array.from({ length: ticks + 1 }, (_, i) => yMin + ((yMax - yMin) * i) / ticks);

  // X-axis labels: first, middle, last.
  const xLabelIdx = ordered.length <= 1
    ? [0]
    : [0, Math.floor((ordered.length - 1) / 2), ordered.length - 1];

  // Overlay (handicap or scoring average) — map each sample by date onto the
  // same x-axis as the wellness series, then draw it on a secondary y-axis.
  const dateToIdx = new Map<string, number>();
  ordered.forEach((d, i) => dateToIdx.set(d.metricDate, i));
  const hcpPoints: { i: number; v: number }[] = [];
  (overlayPoints ?? []).forEach((p) => {
    if (!p.recordedAt) return;
    const day = p.recordedAt.slice(0, 10);
    const i = dateToIdx.get(day);
    if (i != null) hcpPoints.push({ i, v: p.value });
  });
  const fmtOverlay = overlayValueFormatter ?? ((n: number) => n.toFixed(1));
  let hcpD = "";
  let hYMin = 0;
  let hYMax = 0;
  let hYFor: (v: number) => number = () => 0;
  if (hcpPoints.length > 0) {
    const hVals = hcpPoints.map((p) => p.v);
    hYMin = Math.min(...hVals);
    hYMax = Math.max(...hVals);
    if (hYMin === hYMax) {
      hYMin -= 0.5;
      hYMax += 0.5;
    } else {
      const span = hYMax - hYMin;
      hYMin -= span * 0.1;
      hYMax += span * 0.1;
    }
    hYFor = (v: number) => padTop + (1 - (v - hYMin) / (hYMax - hYMin)) * innerH;
    const sorted = hcpPoints.slice().sort((a, b) => a.i - b.i);
    sorted.forEach((p, idx) => {
      const x = xFor(p.i);
      const y = hYFor(p.v);
      hcpD += `${idx === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)} `;
    });
  }

  return (
    <Svg width={width} height={height}>
      {tickValues.map((tv, i) => {
        const y = yFor(tv);
        return (
          <React.Fragment key={`g-${i}`}>
            <Line x1={padLeft} x2={padLeft + innerW} y1={y} y2={y} stroke={Colors.border} strokeWidth={1} />
            <SvgText x={padLeft - 6} y={y + 3} fill={Colors.tabIconDefault} fontSize={9} textAnchor="end">
              {metric.formatValue(tv)}
            </SvgText>
          </React.Fragment>
        );
      })}
      <Path d={d.trim()} stroke={metric.color} strokeWidth={2} fill="none" />
      {points.map((v, i) =>
        v == null ? null : (
          <Circle key={`p-${i}`} cx={xFor(i)} cy={yFor(v)} r={2.5} fill={metric.color} />
        ),
      )}
      {hcpPoints.length > 0 && (
        <>
          <Path
            d={hcpD.trim()}
            stroke={overlayColor}
            strokeWidth={1.5}
            strokeDasharray="4,3"
            fill="none"
          />
          {hcpPoints.map((p, idx) => (
            <Circle
              key={`h-${idx}`}
              cx={xFor(p.i)}
              cy={hYFor(p.v)}
              r={2}
              fill={overlayColor}
            />
          ))}
          <SvgText
            x={padLeft + innerW + 2}
            y={hYFor(hYMax) + 8}
            fill={overlayColor}
            fontSize={9}
            textAnchor="end"
          >
            {fmtOverlay(hYMax)}
          </SvgText>
          <SvgText
            x={padLeft + innerW + 2}
            y={hYFor(hYMin) - 2}
            fill={overlayColor}
            fontSize={9}
            textAnchor="end"
          >
            {fmtOverlay(hYMin)}
          </SvgText>
        </>
      )}
      {xLabelIdx.map((i) => (
        <SvgText
          key={`xl-${i}`}
          x={xFor(i)}
          y={height - 6}
          fill={Colors.tabIconDefault}
          fontSize={9}
          textAnchor="middle"
        >
          {ordered[i]?.metricDate.slice(5) ?? ""}
        </SvgText>
      ))}
    </Svg>
  );
}

export default function WellnessDashboardScreen() {
  const insets = useSafeAreaInsets();
  const { token, user } = useAuth();
  const [range, setRange] = useState<RangeOption>(DEFAULT_RANGE);
  const [series, setSeries] = useState<WellnessDay[]>([]);
  const [handicapTrend, setHandicapTrend] = useState<HandicapPoint[]>([]);
  const [scoringTrend, setScoringTrend] = useState<ScoringPoint[]>([]);
  const [trailingWindow, setTrailingWindow] = useState<TrailingWindowOption>(DEFAULT_TRAILING_WINDOW);
  // Track whether the user's saved preferences have been loaded from the
  // local cache so the first network request waits for them (avoids flashing
  // the default values before applying the player's chosen window/range).
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  // Task #946 / #1091 — when the player picks a window or range we send it on
  // the next request so the server persists it on their profile. Initial
  // loads omit the params and let the server return the values already saved
  // on the user's profile, which are then echoed back and cached locally as a
  // fallback.
  const [pendingPersistWindow, setPendingPersistWindow] = useState(false);
  const [pendingPersistRange, setPendingPersistRange] = useState(false);
  // Hold legacy AsyncStorage values that need to be uploaded once if the
  // server has no stored preference yet. Cleared after the first attempt
  // (success or not) so we don't repeatedly fight a value the user has set on
  // another device.
  const needsLegacyBackfillRef = useRef<TrailingWindowOption | null>(null);
  const needsLegacyRangeBackfillRef = useRef<RangeOption | null>(null);
  const [overlayMode, setOverlayMode] = useState<OverlayMode>("handicap");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chartWidth, setChartWidth] = useState(320);

  // Load the player's persisted preferences (trailing window + visible range)
  // once we know who they are. Stored per-user so multiple accounts on the
  // same device don't overwrite each other's choices.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [storedWin, syncedWin, storedRange, syncedRange] = await Promise.all([
          AsyncStorage.getItem(trailingWindowStorageKey(user?.id)),
          AsyncStorage.getItem(trailingWindowSyncedKey(user?.id)),
          AsyncStorage.getItem(rangeStorageKey(user?.id)),
          AsyncStorage.getItem(rangeSyncedKey(user?.id)),
        ]);
        if (cancelled) return;
        const parsedWin = parseInt(storedWin ?? "");
        const validCachedWin = (TRAILING_WINDOW_OPTIONS as readonly number[]).includes(parsedWin);
        if (validCachedWin) {
          setTrailingWindow(parsedWin as TrailingWindowOption);
        }
        // Track whether we still need to backfill a legacy local-only
        // preference (one stored by an older app version, before the value
        // started persisting server-side). The actual upload only happens if
        // the server reports it has no stored value yet — see load().
        if (validCachedWin && !syncedWin) {
          needsLegacyBackfillRef.current = parsedWin as TrailingWindowOption;
        }
        const parsedRange = parseInt(storedRange ?? "");
        const validCachedRange = (RANGE_OPTIONS as readonly number[]).includes(parsedRange);
        if (validCachedRange) {
          setRange(parsedRange as RangeOption);
        }
        if (validCachedRange && !syncedRange) {
          needsLegacyRangeBackfillRef.current = parsedRange as RangeOption;
        }
      } catch {
        // Ignore storage errors and fall back to the defaults.
      } finally {
        if (!cancelled) setPrefsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const onSelectTrailingWindow = useCallback(
    (w: TrailingWindowOption) => {
      setTrailingWindow(w);
      // Mark that the next request should send (and persist) this choice.
      setPendingPersistWindow(true);
      // Update the local cache immediately so the value is available before
      // the server round-trip finishes (and as a fallback when offline).
      AsyncStorage.setItem(trailingWindowStorageKey(user?.id), String(w)).catch(() => {});
    },
    [user?.id],
  );

  const onSelectRange = useCallback(
    (r: RangeOption) => {
      setRange(r);
      setPendingPersistRange(true);
      AsyncStorage.setItem(rangeStorageKey(user?.id), String(r)).catch(() => {});
    },
    [user?.id],
  );

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    try {
      // Only send the trailingWindow / rangeDays query params when the player
      // has actively selected a value this session. Otherwise let the server
      // respond with the value persisted on their profile so it follows them
      // across devices.
      const params = new URLSearchParams();
      if (pendingPersistRange) {
        params.set("rangeDays", String(range));
      }
      if (pendingPersistWindow) {
        params.set("trailingWindow", String(trailingWindow));
      }
      const qs = params.toString();
      const url = `${BASE_URL}/api/portal/wellness/daily${qs ? `?${qs}` : ""}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setError(`Server error (${res.status})`);
        return;
      }
      let j = await res.json();
      setSeries((j.series ?? []) as WellnessDay[]);
      setHandicapTrend((j.handicapTrend ?? []) as HandicapPoint[]);
      setScoringTrend((j.scoringTrend ?? []) as ScoringPoint[]);

      // If the server still has no stored preference for this user but we
      // have a valid legacy local cache, push the cached value(s) once so the
      // pre-server-persistence choice survives. We deliberately only do this
      // when the server says it has no stored value (`*Stored === false`) —
      // that way a value the user already set on another device wins.
      const legacyWin = needsLegacyBackfillRef.current;
      const legacyRange = needsLegacyRangeBackfillRef.current;
      const winNeedsBackfill = legacyWin != null && j.trailingWindowStored === false;
      const rangeNeedsBackfill = legacyRange != null && j.rangeDaysStored === false;
      if (winNeedsBackfill || rangeNeedsBackfill) {
        if (winNeedsBackfill) needsLegacyBackfillRef.current = null;
        if (rangeNeedsBackfill) needsLegacyRangeBackfillRef.current = null;
        const backfillParams = new URLSearchParams();
        if (winNeedsBackfill) backfillParams.set("trailingWindow", String(legacyWin));
        if (rangeNeedsBackfill) backfillParams.set("rangeDays", String(legacyRange));
        try {
          const upRes = await fetch(
            `${BASE_URL}/api/portal/wellness/daily?${backfillParams.toString()}`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          if (upRes.ok) {
            const uj = await upRes.json();
            setSeries((uj.series ?? []) as WellnessDay[]);
            setHandicapTrend((uj.handicapTrend ?? []) as HandicapPoint[]);
            setScoringTrend((uj.scoringTrend ?? []) as ScoringPoint[]);
            // Prefer the backfill response's authoritative values when
            // updating local state below.
            j = uj;
          }
        } catch {
          // Best-effort backfill — ignore network failures and try again next
          // launch (synced flags are only set after a successful response).
        }
      } else {
        // Server already had stored values for whatever wasn't pending — drop
        // the matching backfill intents so we don't re-try them next refresh.
        if (legacyWin != null) needsLegacyBackfillRef.current = null;
        if (legacyRange != null) needsLegacyRangeBackfillRef.current = null;
      }

      if (typeof j.trailingWindow === "number") {
        setTrailingWindow(j.trailingWindow);
        // Mirror the server's authoritative value into the local cache so an
        // offline launch on this device shows the same window the player set
        // anywhere else, and mark the per-user "synced" flag so we don't try
        // to backfill again on the next launch.
        AsyncStorage.setItem(
          trailingWindowStorageKey(user?.id),
          String(j.trailingWindow),
        ).catch(() => {});
        AsyncStorage.setItem(trailingWindowSyncedKey(user?.id), "1").catch(() => {});
      }
      if (
        typeof j.rangeDays === "number" &&
        (RANGE_OPTIONS as readonly number[]).includes(j.rangeDays)
      ) {
        setRange(j.rangeDays as RangeOption);
        AsyncStorage.setItem(rangeStorageKey(user?.id), String(j.rangeDays)).catch(() => {});
        AsyncStorage.setItem(rangeSyncedKey(user?.id), "1").catch(() => {});
      }
      // Server has now stored (or confirmed) the choices — clear the flags so
      // subsequent refreshes don't keep re-sending them.
      if (pendingPersistWindow) setPendingPersistWindow(false);
      if (pendingPersistRange) setPendingPersistRange(false);
    } catch {
      setError("Network error — pull to retry.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token, range, trailingWindow, pendingPersistWindow, pendingPersistRange, user?.id]);

  useEffect(() => {
    if (!prefsLoaded) return;
    setLoading(true);
    load();
  }, [load, prefsLoaded]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const summaries = useMemo(() => {
    const out: Record<MetricKey, number | null> = {
      readinessScore: null,
      sleepMinutes: null,
      hrvMs: null,
      restingHr: null,
    };
    METRICS.forEach((m) => {
      const vals = series
        .map((d) => d[m.key])
        .filter((v): v is number => typeof v === "number");
      out[m.key] = average(vals);
    });
    return out;
  }, [series]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ title: "Wellness", headerShown: true }} />
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#fff" />}
      >
        <Text style={styles.heading}>Recovery trends</Text>
        <Text style={styles.subheading}>
          Long-term view of readiness, sleep, HRV and resting heart rate.
        </Text>

        <View style={styles.rangeRow}>
          {([30, 60, 90] as RangeOption[]).map((r) => {
            const active = r === range;
            return (
              <TouchableOpacity
                key={r}
                onPress={() => onSelectRange(r)}
                style={[styles.rangeBtn, active && styles.rangeBtnActive]}
                testID={`range-${r}`}
              >
                <Text style={[styles.rangeBtnText, active && styles.rangeBtnTextActive]}>{r}d</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {loading ? (
          <View style={styles.loadingBox}>
            <LoadingSpinner color={Colors.primary} />
          </View>
        ) : error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : series.length === 0 ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>
              No wellness data yet. Connect a wearable from your profile to start syncing.
            </Text>
          </View>
        ) : (
          <View
            onLayout={(e) => setChartWidth(e.nativeEvent.layout.width)}
          >
            <View style={styles.overlayToggleRow}>
              <Text style={styles.overlayToggleLabel}>Overlay</Text>
              <View style={styles.overlayToggleGroup}>
                {(["handicap", "scoring"] as OverlayMode[]).map((mode) => {
                  const active = mode === overlayMode;
                  return (
                    <TouchableOpacity
                      key={mode}
                      onPress={() => setOverlayMode(mode)}
                      style={[styles.overlayToggleBtn, active && styles.overlayToggleBtnActive]}
                      testID={`overlay-${mode}`}
                    >
                      <Text style={[styles.overlayToggleText, active && styles.overlayToggleTextActive]}>
                        {mode === "handicap" ? "Handicap" : `Scoring avg (${trailingWindow}-rd)`}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {overlayMode === "scoring" && (
              <View style={styles.overlayToggleRow}>
                <Text style={styles.overlayToggleLabel}>Avg window</Text>
                <View style={styles.overlayToggleGroup}>
                  {TRAILING_WINDOW_OPTIONS.map((w) => {
                    const active = w === trailingWindow;
                    return (
                      <TouchableOpacity
                        key={w}
                        onPress={() => onSelectTrailingWindow(w)}
                        style={[styles.overlayToggleBtn, active && styles.overlayToggleBtnActive]}
                        testID={`trailing-window-${w}`}
                      >
                        <Text style={[styles.overlayToggleText, active && styles.overlayToggleTextActive]}>
                          {w}-rd
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            )}

            {METRICS.map((m) => {
              const avg = summaries[m.key];
              const showOverlay = m.key === "readinessScore" || m.key === "hrvMs";
              const overlayPoints: OverlayPoint[] | undefined = showOverlay
                ? overlayMode === "handicap"
                  ? handicapTrend.map((h) => ({ value: h.handicapIndex, recordedAt: h.recordedAt }))
                  : scoringTrend.map((s) => ({ value: s.scoringAvg, recordedAt: s.recordedAt }))
                : undefined;
              const overlayColor = overlayMode === "handicap" ? HANDICAP_COLOR : SCORING_COLOR;
              const overlayValueFormatter = overlayMode === "handicap"
                ? (n: number) => n.toFixed(1)
                : (n: number) => n.toFixed(1);
              const firstHcp = handicapTrend[0]?.handicapIndex;
              const lastHcp = handicapTrend[handicapTrend.length - 1]?.handicapIndex;
              const hcpDelta =
                firstHcp != null && lastHcp != null ? lastHcp - firstHcp : null;
              const firstScoring = scoringTrend[0]?.scoringAvg;
              const lastScoring = scoringTrend[scoringTrend.length - 1]?.scoringAvg;
              const scoringDelta =
                firstScoring != null && lastScoring != null ? lastScoring - firstScoring : null;
              return (
                <View key={m.key} style={styles.card}>
                  <View style={styles.cardHeader}>
                    <View>
                      <Text style={styles.cardTitle}>{m.title}</Text>
                      <Text style={styles.cardUnit}>{m.unit}</Text>
                    </View>
                    <View style={{ alignItems: "flex-end" }}>
                      <Text style={styles.cardAvgLabel}>{range}-DAY AVG</Text>
                      <Text style={[styles.cardAvgValue, { color: m.color }]}>
                        {avg == null ? "—" : m.formatValue(avg)}
                      </Text>
                    </View>
                  </View>
                  <MetricChart
                    series={series}
                    metric={m}
                    width={chartWidth - 24}
                    overlayPoints={overlayPoints}
                    overlayColor={overlayColor}
                    overlayValueFormatter={overlayValueFormatter}
                  />
                  {showOverlay && (
                    <View style={styles.legendRow}>
                      <View style={styles.legendItem}>
                        <View style={[styles.legendSwatch, { backgroundColor: m.color }]} />
                        <Text style={styles.legendText}>{m.title}</Text>
                      </View>
                      <View style={styles.legendItem}>
                        <View
                          style={[
                            styles.legendSwatchDashed,
                            { borderColor: overlayColor },
                          ]}
                        />
                        {overlayMode === "handicap" ? (
                          <Text style={styles.legendText}>
                            Handicap index
                            {handicapTrend.length === 0
                              ? " — no handicap data in this range"
                              : lastHcp != null
                              ? ` — now ${lastHcp.toFixed(1)}${
                                  hcpDelta != null && hcpDelta !== 0
                                    ? ` (${hcpDelta > 0 ? "+" : ""}${hcpDelta.toFixed(1)})`
                                    : ""
                                }`
                              : ""}
                          </Text>
                        ) : (
                          <Text style={styles.legendText}>
                            Scoring avg ({trailingWindow}-rd)
                            {scoringTrend.length === 0
                              ? " — no rounds in this range"
                              : lastScoring != null
                              ? ` — now ${lastScoring.toFixed(1)}${
                                  scoringDelta != null && scoringDelta !== 0
                                    ? ` (${scoringDelta > 0 ? "+" : ""}${scoringDelta.toFixed(1)})`
                                    : ""
                                }`
                              : ""}
                          </Text>
                        )}
                      </View>
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  heading: { color: "#fff", fontSize: 22, fontWeight: "700" },
  subheading: { color: Colors.tabIconDefault, fontSize: 13, marginTop: 4, marginBottom: 16 },
  rangeRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  rangeBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  rangeBtnActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  rangeBtnText: { color: Colors.tabIconDefault, fontSize: 13, fontWeight: "600" },
  rangeBtnTextActive: { color: "#fff" },
  loadingBox: { paddingVertical: 48, alignItems: "center" },
  errorBox: {
    padding: 16,
    backgroundColor: Colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  errorText: { color: Colors.tabIconDefault, fontSize: 13 },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
    marginBottom: 14,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 8,
  },
  cardTitle: { color: "#fff", fontSize: 15, fontWeight: "700" },
  cardUnit: { color: Colors.tabIconDefault, fontSize: 11, marginTop: 2 },
  cardAvgLabel: { color: Colors.tabIconDefault, fontSize: 9, letterSpacing: 1.2 },
  cardAvgValue: { fontSize: 20, fontWeight: "700", marginTop: 2 },
  chartEmpty: { alignItems: "center", justifyContent: "center" },
  chartEmptyText: { color: Colors.tabIconDefault, fontSize: 12 },
  legendRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 8,
  },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendSwatch: { width: 12, height: 3, borderRadius: 2 },
  legendSwatchDashed: {
    width: 12,
    height: 0,
    borderTopWidth: 2,
    borderStyle: "dashed",
  },
  legendText: { color: Colors.tabIconDefault, fontSize: 11 },
  overlayToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
    gap: 8,
  },
  overlayToggleLabel: {
    color: Colors.tabIconDefault,
    fontSize: 11,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    fontWeight: "600",
  },
  overlayToggleGroup: {
    flexDirection: "row",
    backgroundColor: Colors.surface,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
  },
  overlayToggleBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  overlayToggleBtnActive: {
    backgroundColor: Colors.primary,
  },
  overlayToggleText: {
    color: Colors.tabIconDefault,
    fontSize: 12,
    fontWeight: "600",
  },
  overlayToggleTextActive: {
    color: "#fff",
  },
});
