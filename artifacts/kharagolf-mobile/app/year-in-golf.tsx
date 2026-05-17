import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Dimensions, Alert, Share, Platform } from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Stack, useLocalSearchParams, router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";
import { authedFetch, BASE_URL } from "./my-360/_shared";
import ViewShot, { captureRef } from "react-native-view-shot";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system/legacy";
import { Buffer } from "buffer";

type Period = "year" | "q1" | "q2" | "q3" | "q4";

// Task #1875 — `GET /api/portal/me/recap-share-stats` response shape.
type RecapShareSourceKey = "copy" | "web_share" | "native_share" | "qr_open" | "crawler" | "unknown";
type RecapShareAssetKey = "card_png" | "og";
interface RecapShareStats {
  total: number;
  totalsByAsset: Record<RecapShareAssetKey, number>;
  totalsBySource: Record<RecapShareSourceKey, number>;
  byPeriod: Array<{
    year: number;
    period: string;
    total: number;
    byAsset: Record<RecapShareAssetKey, number>;
    bySource: Record<RecapShareSourceKey, number>;
  }>;
}

interface PublicProfile {
  publicHandle: string | null;
  publicProfileEnabled: boolean;
}

interface Recap {
  user: { id: number; displayName: string | null };
  window: { year: number; period: Period; label: string; startsAt: string; endsAt: string };
  totals: {
    rounds: number; holes: number; courses: number; partners: number; achievementsUnlocked: number;
  };
  bestRound: { gross: number; courseName: string | null; playedAt: string | null } | null;
  longestDrive: { distanceYards: number; club: string | null; courseName: string | null; recordedAt: string | null } | null;
  lowestHoleScore: { strokes: number; par: number | null; courseName: string | null; holeNumber: number; playedAt: string | null } | null;
  mostImproved: { metric: string; previousValue: number; currentValue: number; deltaLabel: string } | null;
  topCourses: { courseId: number; courseName: string; rounds: number }[];
  topPartners: { name: string; roundsTogether: number }[];
  achievements: { badgeType: string; badgeLabel: string; badgeIcon: string; earnedAt: string }[];
  handicapJourney: { startIndex: number | null; endIndex: number | null; deltaLabel: string; points: { recordedAt: string; index: number }[] };
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");
const STORY_H = Math.min(SCREEN_H * 0.78, 720);

type ChapterKey =
  | "cover" | "rounds" | "bestRound" | "longestDrive" | "lowestHole"
  | "courses" | "partners" | "achievements" | "handicap" | "improved" | "share";

interface Chapter { key: ChapterKey; tint: string; }

const CHAPTERS: Chapter[] = [
  { key: "cover", tint: "#0e7c3a" },
  { key: "rounds", tint: "#2563eb" },
  { key: "bestRound", tint: "#7c3aed" },
  { key: "longestDrive", tint: "#ea580c" },
  { key: "lowestHole", tint: "#0891b2" },
  { key: "courses", tint: "#16a34a" },
  { key: "partners", tint: "#dc2626" },
  { key: "achievements", tint: "#ca8a04" },
  { key: "handicap", tint: "#7e22ce" },
  { key: "improved", tint: "#059669" },
  { key: "share", tint: "#111827" },
];

export default function YearInGolfScreen() {
  const { token, user } = useAuth();
  const params = useLocalSearchParams<{ year?: string; period?: string }>();
  const initialYear = params.year ? parseInt(String(params.year), 10) : new Date().getFullYear();
  const initialPeriod = (["q1", "q2", "q3", "q4", "year"].includes(String(params.period)) ? params.period : "year") as Period;

  const [year, setYear] = useState<number>(initialYear);
  const [period, setPeriod] = useState<Period>(initialPeriod);
  const [recap, setRecap] = useState<Recap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pushOptIn, setPushOptIn] = useState<boolean | null>(null);
  // Task #1875 — recap-share-opens panel, gated on public profile.
  const [publicProfile, setPublicProfile] = useState<PublicProfile | null>(null);
  const [shareStats, setShareStats] = useState<RecapShareStats | null>(null);

  const scrollRef = useRef<ScrollView>(null);
  const [chapterIdx, setChapterIdx] = useState(0);
  const shotRef = useRef<ViewShot>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const r = await authedFetch<Recap>(`/api/portal/year-in-golf?year=${year}&period=${period}`, token);
      setRecap(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, year, period]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!token) return;
    authedFetch<{ pushEnabled: boolean }>(`/api/portal/year-in-golf/preferences`, token)
      .then(r => setPushOptIn(r.pushEnabled))
      .catch(() => setPushOptIn(null));
  }, [token]);

  useEffect(() => {
    if (!token) return;
    authedFetch<PublicProfile>(`/api/portal/me/public-profile`, token)
      .then(setPublicProfile)
      .catch(() => setPublicProfile(null));
  }, [token]);

  const publicProfileEnabled = !!(publicProfile?.publicHandle && publicProfile?.publicProfileEnabled);

  useEffect(() => {
    if (!token || !publicProfileEnabled) {
      setShareStats(null);
      return;
    }
    authedFetch<RecapShareStats>(`/api/portal/me/recap-share-stats`, token)
      .then(setShareStats)
      .catch(() => setShareStats(null));
  }, [token, publicProfileEnabled]);

  const togglePush = useCallback(async () => {
    if (!token || pushOptIn == null) return;
    const next = !pushOptIn;
    setPushOptIn(next);
    try {
      await authedFetch(`/api/portal/year-in-golf/preferences`, token, {
        method: "POST",
        body: JSON.stringify({ pushEnabled: next }),
      });
    } catch {
      setPushOptIn(!next);
      Alert.alert("Could not update preference", "Please try again.");
    }
  }, [token, pushOptIn]);

  const onScrollEnd = useCallback((e: { nativeEvent: { contentOffset: { x: number } } }) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W);
    setChapterIdx(Math.max(0, Math.min(CHAPTERS.length - 1, i)));
  }, []);

  const goNext = useCallback(() => {
    const next = Math.min(CHAPTERS.length - 1, chapterIdx + 1);
    scrollRef.current?.scrollTo({ x: next * SCREEN_W, animated: true });
    setChapterIdx(next);
  }, [chapterIdx]);

  const goPrev = useCallback(() => {
    const prev = Math.max(0, chapterIdx - 1);
    scrollRef.current?.scrollTo({ x: prev * SCREEN_W, animated: true });
    setChapterIdx(prev);
  }, [chapterIdx]);

  const handleShare = useCallback(async () => {
    try {
      if (!shotRef.current) return;
      const uri = await captureRef(shotRef, { format: "png", quality: 1, result: "tmpfile" });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(uri, { dialogTitle: "Share my Year in Golf" });
      } else {
        await Share.share({ message: `My ${recap?.window.label ?? "Year"} in Golf — ${recap?.totals.rounds ?? 0} rounds played 🏌️` });
      }
    } catch (err) {
      console.warn("[year-in-golf] share failed", err);
    }
  }, [recap]);

  const shareVideo = useCallback(async () => {
    try {
      if (!token) throw new Error("Not signed in");
      const url = `${BASE_URL}/api/portal/year-in-golf/video.mp4?year=${year}&period=${period}`;
      const dest = `${FileSystem.cacheDirectory ?? ""}year-in-golf-${year}-${period}.mp4`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const buf = await res.arrayBuffer();
      const base64 = Buffer.from(buf).toString("base64");
      await FileSystem.writeAsStringAsync(dest, base64, { encoding: FileSystem.EncodingType.Base64 });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(dest, { mimeType: "video/mp4", dialogTitle: "Share my Year in Golf video", UTI: "public.mpeg-4" });
      } else {
        Alert.alert("Saved", `Video saved to ${Platform.OS === "ios" ? "Files app" : "device storage"}.`);
      }
    } catch (err) {
      Alert.alert("Could not create video", (err as Error).message);
    }
  }, [year, period, token]);

  const downloadCard = useCallback(async () => {
    try {
      if (!shotRef.current) return;
      const uri = await captureRef(shotRef, { format: "png", quality: 1, result: "tmpfile" });
      const dest = `${FileSystem.cacheDirectory ?? ""}year-in-golf-${year}-${period}.png`;
      await FileSystem.copyAsync({ from: uri, to: dest });
      Alert.alert("Saved", `Card saved to ${Platform.OS === "ios" ? "Files app" : "device storage"}.`);
    } catch (err) {
      Alert.alert("Could not save", (err as Error).message);
    }
  }, [year, period]);

  const periods: { key: Period; label: string }[] = useMemo(() => ([
    { key: "year", label: "Year" },
    { key: "q1", label: "Q1" },
    { key: "q2", label: "Q2" },
    { key: "q3", label: "Q3" },
    { key: "q4", label: "Q4" },
  ]), []);

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ title: "Year in Golf", headerStyle: { backgroundColor: "#0a0a0a" }, headerTintColor: "#fff" }} />

      <View style={styles.toolbar}>
        <View style={styles.toolbarRow}>
          <TouchableOpacity style={styles.yearBtn} onPress={() => setYear(y => y - 1)}>
            <Feather name="chevron-left" size={18} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.yearText}>{year}</Text>
          <TouchableOpacity style={styles.yearBtn} onPress={() => setYear(y => y + 1)}>
            <Feather name="chevron-right" size={18} color="#fff" />
          </TouchableOpacity>
        </View>
        <View style={styles.periodRow}>
          {periods.map(p => (
            <TouchableOpacity
              key={p.key}
              style={[styles.periodPill, period === p.key && styles.periodPillActive]}
              onPress={() => setPeriod(p.key)}
            >
              <Text style={[styles.periodPillText, period === p.key && styles.periodPillTextActive]}>{p.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {loading && (
        <View style={styles.center}><LoadingSpinner color={Colors.primary} /><Text style={styles.dim}>Building your recap…</Text></View>
      )}
      {!loading && error && (
        <View style={styles.center}><Text style={styles.errText}>{error}</Text><TouchableOpacity onPress={load} style={styles.retry}><Text style={styles.retryText}>Retry</Text></TouchableOpacity></View>
      )}

      {!loading && !error && recap && (
        <>
          <View style={styles.progressRow}>
            {CHAPTERS.map((c, i) => (
              <View key={c.key} style={[styles.progressDot, i === chapterIdx && styles.progressDotActive]} />
            ))}
          </View>

          <ScrollView
            ref={scrollRef}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={onScrollEnd}
            style={{ height: STORY_H }}
          >
            {CHAPTERS.map((c, i) => (
              <View key={c.key} style={{ width: SCREEN_W }}>
                <Chapter
                  chapter={c}
                  recap={recap}
                  user={user}
                  shotRef={i === chapterIdx ? shotRef : undefined}
                  onShare={handleShare}
                  onSave={downloadCard}
                  onShareVideo={shareVideo}
                  pushOptIn={pushOptIn}
                  onTogglePush={togglePush}
                  publicProfileEnabled={publicProfileEnabled}
                  shareStats={shareStats}
                />
              </View>
            ))}
          </ScrollView>

          <View style={styles.navRow}>
            <TouchableOpacity onPress={goPrev} style={styles.navBtn} disabled={chapterIdx === 0}>
              <Feather name="chevron-left" size={20} color={chapterIdx === 0 ? "#444" : "#fff"} />
              <Text style={[styles.navBtnText, chapterIdx === 0 && { color: "#444" }]}>Back</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={handleShare} style={[styles.navBtn, styles.navBtnPrimary]}>
              <Feather name="share-2" size={18} color="#fff" />
              <Text style={[styles.navBtnText, { color: "#fff" }]}>Share</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={goNext} style={styles.navBtn} disabled={chapterIdx === CHAPTERS.length - 1}>
              <Text style={[styles.navBtnText, chapterIdx === CHAPTERS.length - 1 && { color: "#444" }]}>Next</Text>
              <Feather name="chevron-right" size={20} color={chapterIdx === CHAPTERS.length - 1 ? "#444" : "#fff"} />
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  );
}

function Chapter({ chapter, recap, user, shotRef, onShare, onSave, onShareVideo, pushOptIn, onTogglePush, publicProfileEnabled, shareStats }: {
  chapter: Chapter;
  recap: Recap;
  user: { displayName?: string | null } | null | undefined;
  shotRef?: React.RefObject<ViewShot | null> | undefined;
  onShare: () => void;
  onSave: () => void;
  onShareVideo: () => void;
  pushOptIn: boolean | null;
  onTogglePush: () => void;
  publicProfileEnabled: boolean;
  shareStats: RecapShareStats | null;
}) {
  const cardBody = renderChapterBody(chapter.key, recap, onShare, onSave, onShareVideo, pushOptIn, onTogglePush, publicProfileEnabled, shareStats);
  const inner = (
    <View style={[styles.card, { backgroundColor: chapter.tint }]}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardKicker}>{recap.window.label} • Year in Golf</Text>
        <Text style={styles.cardName}>{user?.displayName ?? recap.user.displayName ?? "Player"}</Text>
      </View>
      <View style={styles.cardContent}>{cardBody}</View>
      <View style={styles.cardFooter}>
        <Text style={styles.cardFooterText}>KHARAGOLF</Text>
      </View>
    </View>
  );
  if (shotRef) {
    return (
      <View style={styles.cardWrap}>
        <ViewShot ref={shotRef} options={{ format: "png", quality: 1 }} style={{ width: "100%" }}>
          {inner}
        </ViewShot>
      </View>
    );
  }
  return <View style={styles.cardWrap}>{inner}</View>;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function renderChapterBody(
  key: ChapterKey,
  r: Recap,
  onShare: () => void,
  onSave: () => void,
  onShareVideo: () => void,
  pushOptIn: boolean | null,
  onTogglePush: () => void,
  publicProfileEnabled: boolean,
  shareStats: RecapShareStats | null,
): React.ReactNode {
  switch (key) {
    case "cover":
      return (
        <>
          <Text style={styles.bigStat}>{r.totals.rounds}</Text>
          <Text style={styles.statLabel}>rounds played</Text>
          <Text style={[styles.statSub, { marginTop: 24 }]}>Welcome to your {r.window.label} recap.</Text>
        </>
      );
    case "rounds":
      return (
        <>
          <Text style={styles.bigStat}>{r.totals.holes.toLocaleString()}</Text>
          <Text style={styles.statLabel}>total holes</Text>
          <Text style={[styles.statSub, { marginTop: 24 }]}>{r.totals.rounds} rounds across {r.totals.courses} courses</Text>
        </>
      );
    case "bestRound":
      return r.bestRound ? (
        <>
          <Text style={styles.bigStat}>{r.bestRound.gross}</Text>
          <Text style={styles.statLabel}>your best round</Text>
          {r.bestRound.courseName && <Text style={styles.statSub}>{r.bestRound.courseName}</Text>}
          {r.bestRound.playedAt && <Text style={styles.statSubSm}>{fmtDate(r.bestRound.playedAt)}</Text>}
        </>
      ) : <EmptyChapter label="No verified rounds in this window." />;
    case "longestDrive":
      return r.longestDrive ? (
        <>
          <Text style={styles.bigStat}>{r.longestDrive.distanceYards}<Text style={styles.unit}> yds</Text></Text>
          <Text style={styles.statLabel}>longest drive</Text>
          {r.longestDrive.club && <Text style={styles.statSub}>with the {r.longestDrive.club}</Text>}
          {r.longestDrive.courseName && <Text style={styles.statSubSm}>{r.longestDrive.courseName}</Text>}
        </>
      ) : <EmptyChapter label="No tracked tee shots yet." />;
    case "lowestHole":
      return r.lowestHoleScore ? (
        <>
          <Text style={styles.bigStat}>{r.lowestHoleScore.strokes}{r.lowestHoleScore.par != null && (<Text style={styles.unit}> on a par {r.lowestHoleScore.par}</Text>)}</Text>
          <Text style={styles.statLabel}>your lowest hole</Text>
          <Text style={styles.statSub}>Hole {r.lowestHoleScore.holeNumber}</Text>
          {r.lowestHoleScore.playedAt && <Text style={styles.statSubSm}>{fmtDate(r.lowestHoleScore.playedAt)}</Text>}
        </>
      ) : <EmptyChapter label="Hole-by-hole data not available." />;
    case "courses":
      return r.topCourses.length > 0 ? (
        <>
          <Text style={styles.bigStat}>{r.totals.courses}</Text>
          <Text style={styles.statLabel}>{r.totals.courses === 1 ? "course played" : "courses played"}</Text>
          <View style={{ marginTop: 16, alignSelf: "stretch" }}>
            {r.topCourses.slice(0, 3).map(c => (
              <View key={c.courseId} style={styles.listRow}>
                <Text style={styles.listText} numberOfLines={1}>{c.courseName}</Text>
                <Text style={styles.listValue}>{c.rounds}</Text>
              </View>
            ))}
          </View>
        </>
      ) : <EmptyChapter label="No courses played in this window." />;
    case "partners":
      return r.topPartners.length > 0 ? (
        <>
          <Text style={styles.bigStat}>{r.totals.partners}</Text>
          <Text style={styles.statLabel}>playing partners</Text>
          <View style={{ marginTop: 16, alignSelf: "stretch" }}>
            {r.topPartners.slice(0, 4).map(p => (
              <View key={p.name} style={styles.listRow}>
                <Text style={styles.listText} numberOfLines={1}>{p.name}</Text>
                <Text style={styles.listValue}>{p.roundsTogether}×</Text>
              </View>
            ))}
          </View>
        </>
      ) : <EmptyChapter label="No tournament partners yet." />;
    case "achievements":
      return r.achievements.length > 0 ? (
        <>
          <Text style={styles.bigStat}>{r.totals.achievementsUnlocked}</Text>
          <Text style={styles.statLabel}>achievements unlocked</Text>
          <View style={styles.badgesGrid}>
            {r.achievements.slice(0, 6).map(a => (
              <View key={a.badgeType} style={styles.badge}>
                <Text style={styles.badgeIcon}>{a.badgeIcon}</Text>
                <Text style={styles.badgeLabel} numberOfLines={2}>{a.badgeLabel}</Text>
              </View>
            ))}
          </View>
        </>
      ) : <EmptyChapter label="Keep playing — badges await." />;
    case "handicap":
      return r.handicapJourney.points.length > 0 ? (
        <>
          <Text style={styles.bigStat}>{r.handicapJourney.endIndex?.toFixed(1) ?? "—"}</Text>
          <Text style={styles.statLabel}>current handicap index</Text>
          <Text style={styles.statSub}>{r.handicapJourney.deltaLabel || "—"}</Text>
          {r.handicapJourney.startIndex != null && (
            <Text style={styles.statSubSm}>Started window at {r.handicapJourney.startIndex.toFixed(1)}</Text>
          )}
        </>
      ) : <EmptyChapter label="No handicap history posted." />;
    case "improved":
      return r.mostImproved ? (
        <>
          <Text style={styles.statSub}>Most improved</Text>
          <Text style={[styles.bigStat, { marginTop: 12 }]}>{r.mostImproved.metric}</Text>
          <Text style={styles.statLabel}>{r.mostImproved.previousValue} → {r.mostImproved.currentValue}</Text>
          <Text style={[styles.statSub, { marginTop: 8 }]}>{r.mostImproved.deltaLabel}</Text>
        </>
      ) : <EmptyChapter label="More history needed to spot improvement." />;
    case "share":
      return (
        <>
          <Text style={styles.bigStat}>That's a wrap 🏌️</Text>
          <Text style={[styles.statSub, { marginTop: 12 }]}>Share your {r.window.label} story</Text>
          <View style={{ flexDirection: "row", gap: 12, marginTop: 24, flexWrap: "wrap", justifyContent: "center" }}>
            <TouchableOpacity onPress={onShare} style={styles.shareBtn}>
              <Feather name="share-2" size={16} color="#fff" />
              <Text style={styles.shareBtnText}>Share card</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onSave} style={[styles.shareBtn, { backgroundColor: "#1f2937" }]}>
              <Feather name="download" size={16} color="#fff" />
              <Text style={styles.shareBtnText}>Save image</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onShareVideo} style={[styles.shareBtn, { backgroundColor: "#7c3aed" }]}>
              <Feather name="film" size={16} color="#fff" />
              <Text style={styles.shareBtnText}>Share video</Text>
            </TouchableOpacity>
          </View>
          {publicProfileEnabled && <RecapShareStatsPanel stats={shareStats} />}
          <View style={{ marginTop: 28, alignSelf: "stretch" }}>
            <TouchableOpacity onPress={onTogglePush} style={styles.optoutRow}>
              <Feather name={pushOptIn === false ? "bell-off" : "bell"} size={16} color="#fff" />
              <Text style={styles.optoutText}>
                {pushOptIn === false ? "Recap push notifications: OFF" : "Recap push notifications: ON"}
              </Text>
            </TouchableOpacity>
            <Text style={styles.optoutHint}>Toggle to opt out of all KHARAGOLF push notifications.</Text>
          </View>
        </>
      );
  }
}

// Task #1875 — `web_share` + `native_share` collapse to one bucket on
// mobile (the OS share sheet IS the native share); `qr_open` + `unknown`
// fall under "Other" so chips stay readable at phone width.
const SHARE_SOURCE_BUCKETS: Array<{
  key: "copy" | "native_share" | "crawler" | "other";
  label: string;
  icon: React.ComponentProps<typeof Feather>["name"];
  members: RecapShareSourceKey[];
}> = [
  { key: "copy", label: "Copied link", icon: "copy", members: ["copy"] },
  { key: "native_share", label: "Native share", icon: "share-2", members: ["web_share", "native_share"] },
  { key: "crawler", label: "Link previews", icon: "link-2", members: ["crawler"] },
  { key: "other", label: "Other", icon: "more-horizontal", members: ["qr_open", "unknown"] },
];

function RecapShareStatsPanel({ stats }: { stats: RecapShareStats | null }) {
  // Render nothing until stats land (or on fetch failure) so we never
  // show a stuck placeholder.
  if (!stats) return null;
  const total = stats.total ?? 0;
  const buckets = SHARE_SOURCE_BUCKETS.map(b => ({
    ...b,
    n: b.members.reduce((acc, k) => acc + (stats.totalsBySource[k] ?? 0), 0),
  }))
    .filter(b => b.n > 0)
    .sort((a, b) => b.n - a.n);
  return (
    <View style={styles.recapStatsPanel} testID="recap-share-stats">
      <View style={styles.recapStatsHeaderRow}>
        <Feather name="eye" size={14} color="#fff" />
        <Text style={styles.recapStatsHeaderText} testID="recap-share-stats-headline">
          {total === 0
            ? "Your public recap hasn't been opened yet."
            : `Your recap has been opened ${total.toLocaleString()} ${total === 1 ? "time" : "times"}.`}
        </Text>
      </View>
      {buckets.length > 0 && (
        <View style={styles.recapStatsChipsRow}>
          {buckets.slice(0, 3).map(b => (
            <View
              key={b.key}
              style={styles.recapStatsChip}
              testID={`recap-share-stats-chip-${b.key}`}
            >
              <Feather name={b.icon} size={11} color="#fff" />
              <Text style={styles.recapStatsChipText}>{b.label} · {b.n.toLocaleString()}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function EmptyChapter({ label }: { label: string }) {
  return (
    <View style={{ alignItems: "center" }}>
      <Feather name="meh" size={48} color="#fff" style={{ opacity: 0.5 }} />
      <Text style={[styles.statSub, { marginTop: 12, textAlign: "center" }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0a0a0a" },
  toolbar: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 10 },
  toolbarRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 16 },
  yearBtn: { backgroundColor: "#1f2937", padding: 8, borderRadius: 8 },
  yearText: { color: "#fff", fontSize: 22, fontWeight: "700", minWidth: 80, textAlign: "center" },
  periodRow: { flexDirection: "row", justifyContent: "center", gap: 8, flexWrap: "wrap" },
  periodPill: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: "#374151" },
  periodPillActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  periodPillText: { color: "#9ca3af", fontSize: 13, fontWeight: "600" },
  periodPillTextActive: { color: "#0a0a0a" },
  progressRow: { flexDirection: "row", justifyContent: "center", gap: 4, paddingVertical: 6, paddingHorizontal: 16 },
  progressDot: { flex: 1, height: 3, backgroundColor: "#374151", borderRadius: 2 },
  progressDotActive: { backgroundColor: "#fff" },
  cardWrap: { padding: 16, height: STORY_H },
  card: { flex: 1, borderRadius: 24, padding: 24, justifyContent: "space-between", overflow: "hidden" },
  cardHeader: {},
  cardKicker: { color: "rgba(255,255,255,0.7)", fontSize: 12, fontWeight: "700", letterSpacing: 1.2, textTransform: "uppercase" },
  cardName: { color: "#fff", fontSize: 22, fontWeight: "800", marginTop: 4 },
  cardContent: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 12 },
  cardFooter: { alignItems: "flex-end" },
  cardFooterText: { color: "rgba(255,255,255,0.65)", fontSize: 11, fontWeight: "700", letterSpacing: 1.4 },
  bigStat: { color: "#fff", fontSize: 64, fontWeight: "800", textAlign: "center" },
  unit: { fontSize: 24, fontWeight: "600" },
  statLabel: { color: "rgba(255,255,255,0.85)", fontSize: 16, fontWeight: "600", marginTop: 4, textAlign: "center" },
  statSub: { color: "rgba(255,255,255,0.85)", fontSize: 14, marginTop: 8, textAlign: "center" },
  statSubSm: { color: "rgba(255,255,255,0.65)", fontSize: 12, marginTop: 4, textAlign: "center" },
  listRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.15)" },
  listText: { color: "#fff", fontSize: 14, fontWeight: "500", flex: 1, marginRight: 8 },
  listValue: { color: "#fff", fontSize: 14, fontWeight: "700" },
  badgesGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 16, justifyContent: "center" },
  badge: { width: "30%", aspectRatio: 1, backgroundColor: "rgba(255,255,255,0.15)", borderRadius: 12, alignItems: "center", justifyContent: "center", padding: 8 },
  badgeIcon: { fontSize: 24 },
  badgeLabel: { color: "#fff", fontSize: 11, fontWeight: "600", textAlign: "center", marginTop: 4 },
  navRow: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 24, paddingVertical: 12 },
  navBtn: { flexDirection: "row", alignItems: "center", gap: 4, padding: 10 },
  navBtnPrimary: { backgroundColor: Colors.primary, borderRadius: 24, paddingHorizontal: 18 },
  navBtnText: { color: "#fff", fontWeight: "700" },
  shareBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: Colors.primary, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20 },
  shareBtnText: { color: "#fff", fontWeight: "700" },
  optoutRow: { flexDirection: "row", alignItems: "center", gap: 8, justifyContent: "center" },
  optoutText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  optoutHint: { color: "rgba(255,255,255,0.7)", fontSize: 11, marginTop: 4, textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 },
  dim: { color: "#9ca3af", fontSize: 13 },
  errText: { color: "#ef4444", textAlign: "center" },
  retry: { marginTop: 12, padding: 10, backgroundColor: Colors.primary, borderRadius: 8 },
  retryText: { color: "#fff", fontWeight: "700" },
  // Task #1875 — recap-share-stats panel inside the share chapter card.
  recapStatsPanel: {
    marginTop: 20,
    alignSelf: "stretch",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
    backgroundColor: "rgba(0,0,0,0.25)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  recapStatsHeaderRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  recapStatsHeaderText: { color: "#fff", fontSize: 13, fontWeight: "600", flex: 1, flexShrink: 1 },
  recapStatsChipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  recapStatsChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.18)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
  },
  recapStatsChipText: { color: "#fff", fontSize: 11, fontWeight: "500" },
});
