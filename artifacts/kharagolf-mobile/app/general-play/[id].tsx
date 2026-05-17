import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Pressable,
  Linking,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { router, useLocalSearchParams } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import * as Location from "expo-location";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";
import HoleMapSheet from "@/components/HoleMapSheet";
import { buildCorrectionDeepLink } from "@/utils/correctionDeepLink";

const STANDARD_CLUBS = ["Dr","3W","5W","7W","2H","3H","4H","5H","3I","4I","5I","6I","7I","8I","9I","PW","GW","SW","LW","Putter"];
const MISS_DIRECTIONS = ["Left","Right","Short","Long","On Target"] as const;
const LIE_TYPES = ["Tee","Fairway","Rough","Bunker","Hazard","Green"] as const;
const SHOT_SHAPES = ["Draw","Straight","Fade"] as const;
const PENALTY_REASONS = ["OB","Water","Unplayable","Other"] as const;

const GOLD = "#C9A84C";

interface CourseHole {
  holeNumber: number;
  par: number;
  handicap: number | null;
  distance: number | null;
}

interface CourseHoleGps {
  holeNumber: number;
  greenCentreLat?: string | null;
  greenCentreLng?: string | null;
  greenFrontLat?: string | null;
  greenFrontLng?: string | null;
  greenBackLat?: string | null;
  greenBackLng?: string | null;
  yardageWhite?: number | null;
}

interface WeatherData {
  windSpeed: number;
  windDirection: number;
  temperature: number;
  weatherCode: number;
}

interface HoleScore {
  holeNumber: number;
  par: number | null;
  strokeIndex: number | null;
  strokes: number;
}

interface MarkerRecord {
  id: number;
  markerName: string;
  markerEmail: string | null;
  confirmationStatus: string;
}

interface RoundDetail {
  round: {
    id: number;
    courseId: number;
    holesPlayed: number;
    status: string;
    grossScore: number | null;
    scoreDifferential: string | null;
    playedAt: string;
    markerDeadlineAt: string | null;
  };
  holes: HoleScore[];
  markers: MarkerRecord[];
  courseHoles: CourseHole[];
  courseRating?: number | null;
  courseSlope?: number | null;
  coursePar?: number | null;
}

// Task #869 — round-summary badges showing % of shots captured per source.
// Mirrors the web ShotSourceBadges palette (sky=watch, purple=phone,
// amber=scorer, grey=manual) so players see how reliable their tracking was.
type SourceBreakdownProp = { counts: { watch: number; phone: number; scorer: number; manual: number }; total: number };
function ShotSourceBadges({ breakdown }: { breakdown: SourceBreakdownProp | null }) {
  if (!breakdown || breakdown.total === 0) return null;
  const styles_ = sourceBadgeStyles;
  const order: Array<'watch'|'phone'|'scorer'|'manual'> = ['watch','phone','scorer','manual'];
  const meta: Record<'watch'|'phone'|'scorer'|'manual', { label: string; bg: string; border: string; fg: string }> = {
    watch:  { label: 'Watch',  bg: 'rgba(14,165,233,0.18)',  border: 'rgba(14,165,233,0.35)',  fg: '#7dd3fc' },
    phone:  { label: 'Phone',  bg: 'rgba(168,85,247,0.18)',  border: 'rgba(168,85,247,0.35)',  fg: '#d8b4fe' },
    scorer: { label: 'Scorer', bg: 'rgba(245,158,11,0.18)',  border: 'rgba(245,158,11,0.35)',  fg: '#fcd34d' },
    manual: { label: 'Manual', bg: 'rgba(107,114,128,0.20)', border: 'rgba(107,114,128,0.40)', fg: '#d1d5db' },
  };
  return (
    <View style={styles_.row}>
      {order.map(src => {
        const n = breakdown.counts[src];
        if (n === 0) return null;
        const pct = Math.round((n / breakdown.total) * 100);
        const m = meta[src];
        return (
          <View key={src} style={[styles_.badge, { backgroundColor: m.bg, borderColor: m.border }]}>
            <Text style={[styles_.badgeText, { color: m.fg }]}>{m.label} {pct}%</Text>
          </View>
        );
      })}
    </View>
  );
}

const sourceBadgeStyles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 16, justifyContent: 'center' },
  badge: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontSize: 11, fontWeight: '600' },
});

export default function GeneralPlayRoundScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { token } = useAuth();
  const baseUrl = process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
    : "";

  const [detail, setDetail] = useState<RoundDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentHole, setCurrentHole] = useState(1);
  const [strokes, setStrokes] = useState(4);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [courseHandicap, setCourseHandicap] = useState<number | null>(null);

  // Shot tracking state
  const [showShotPanel, setShowShotPanel] = useState(false);
  const [shotsByHole, setShotsByHole] = useState<Record<number, number>>({}); // holeNumber -> count
  const [selectedShotType, setSelectedShotType] = useState<string>("fairway");
  const [selectedClub, setSelectedClub] = useState<string | null>(null);
  const [selectedMissDir, setSelectedMissDir] = useState<string | null>(null);
  const [selectedLieType, setSelectedLieType] = useState<string | null>(null);
  const [selectedShotShape, setSelectedShotShape] = useState<string | null>(null);
  const [selectedPenaltyReason, setSelectedPenaltyReason] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<Location.LocationObject | null>(null);
  const locationSub = useRef<Location.LocationSubscription | null>(null);
  const prevHoleForShots = useRef(1);
  const [clubProfile, setClubProfile] = useState<{ club: string; avgDistance: number }[]>([]);

  // Task #869 — per-source shot counts for the round summary badges. Mirrors the
  // web ShotSourceBadges UI so mobile players (most likely to mix phone-auto and
  // manual entry) can see how reliable their tracking was.
  type SourceBreakdown = { counts: { watch: number; phone: number; scorer: number; manual: number }; total: number };
  const [sourceBreakdown, setSourceBreakdown] = useState<SourceBreakdown | null>(null);

  // Course Map state
  const [showMap, setShowMap] = useState(false);
  const [holesGps, setHolesGps] = useState<CourseHoleGps[]>([]);
  const [userLat, setUserLat] = useState<number | null>(null);
  const [userLng, setUserLng] = useState<number | null>(null);
  const [weather, setWeather] = useState<WeatherData | null>(null);

  async function load() {
    try {
      const res = await fetch(`${baseUrl}/api/portal/general-play/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { router.back(); return; }
      const data: RoundDetail = await res.json();
      setDetail(data);

      const scored = new Set(data.holes.map(h => h.holeNumber));
      const totalHoles = data.round.holesPlayed;
      let firstUnscored = 1;
      for (let h = 1; h <= totalHoles; h++) {
        if (!scored.has(h)) { firstUnscored = h; break; }
        if (h === totalHoles) firstUnscored = totalHoles;
      }
      setCurrentHole(firstUnscored);

      const ch = data.courseHoles.find(h => h.holeNumber === firstUnscored);
      if (ch) setStrokes(ch.par);
    } finally { setLoading(false); }
  }

  useEffect(() => { if (id && token) { load(); loadShotCounts(); loadClubProfileGP(); loadSourceBreakdown(); } }, [id, token]);

  async function loadSourceBreakdown() {
    if (!id || !token) return;
    try {
      const res = await fetch(`${baseUrl}/api/portal/rounds/1/source-breakdown?generalPlayRoundId=${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data: SourceBreakdown = await res.json();
      setSourceBreakdown(data);
    } catch { /* non-critical */ }
  }

  async function loadClubProfileGP() {
    if (!token) return;
    try {
      const res = await fetch(`${baseUrl}/api/portal/club-profile`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) {
        setClubProfile(data.filter((e: { club: string | null; avgDistance: number | null }) => e.club && e.avgDistance).map((e: { club: string; avgDistance: number }) => ({ club: e.club, avgDistance: e.avgDistance })));
      }
    } catch { /* non-critical */ }
  }

  async function loadShotCounts() {
    if (!id || !token) return;
    try {
      const res = await fetch(`${baseUrl}/api/portal/rounds/1/shots?generalPlayRoundId=${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      // API returns [{ hole: number, shots: Shot[] }]
      const groups: { hole: number; shots: unknown[] }[] = await res.json();
      const counts: Record<number, number> = {};
      for (const g of groups) {
        if (g.hole && Array.isArray(g.shots)) counts[g.hole] = g.shots.length;
      }
      setShotsByHole(counts);
    } catch { /* non-critical */ }
  }

  // GPS location for shot tracking
  useEffect(() => {
    Location.requestForegroundPermissionsAsync().then(({ status }) => {
      if (status !== "granted") return;
      Location.watchPositionAsync({ accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 5 }, loc => {
        setUserLocation(loc);
      }).then(sub => { locationSub.current = sub; }).catch(() => {});
    }).catch(() => {});
    return () => { locationSub.current?.remove(); };
  }, []);

  // Reset shot selections when hole changes
  useEffect(() => {
    if (prevHoleForShots.current !== currentHole) {
      prevHoleForShots.current = currentHole;
      setSelectedClub(null);
      setSelectedMissDir(null);
      setSelectedLieType(null);
      setSelectedShotShape(null);
      setSelectedPenaltyReason(null);
      setShowShotPanel(false);
    }
  }, [currentHole]);

  const handleLogShot = useCallback(async () => {
    if (!id || !token) return;
    const shotCount = shotsByHole[currentHole] ?? 0;
    const shotNum = shotCount + 1;
    try {
      const res = await fetch(`${baseUrl}/api/portal/watch/submit-shot`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          generalPlayRoundId: parseInt(id),
          round: 1,
          holeNumber: currentHole,
          shotNumber: shotNum,
          shotType: selectedShotType,
          club: selectedClub ?? null,
          missDirection: selectedMissDir ?? null,
          lieType: selectedLieType ?? null,
          shotShape: selectedShotShape ?? null,
          penaltyReason: selectedPenaltyReason ?? null,
          latitude: userLocation?.coords.latitude ?? null,
          longitude: userLocation?.coords.longitude ?? null,
        }),
      });
      if (!res.ok) {
        // Task #469 — surface a consent prompt when the API blocks GPS shot ingestion.
        const body = await res.json().catch(() => ({} as { code?: string; consentRequired?: { message?: string } }));
        if (res.status === 403 && body.code === "CONSENT_REQUIRED") {
          Alert.alert(
            "GPS consent required",
            body.consentRequired?.message ?? "Enable GPS consent to record shots.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Open Consent Settings", onPress: () => router.push("/my-360/consents") },
            ],
          );
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      setShotsByHole(prev => ({ ...prev, [currentHole]: shotNum }));
      // Task #869 — refresh source breakdown so badges reflect the new shot.
      loadSourceBreakdown();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      // Reset selections for next shot
      setSelectedClub(null);
      setSelectedMissDir(null);
      setSelectedLieType(null);
      setSelectedShotShape(null);
      setSelectedPenaltyReason(null);
    } catch {
      Alert.alert("Shot not saved", "Check your connection and try again.");
    }
  }, [id, token, baseUrl, currentHole, shotsByHole, selectedShotType, selectedClub, selectedMissDir, selectedLieType, selectedShotShape, selectedPenaltyReason, userLocation]);

  // Fetch GPS data for course holes when round detail is loaded
  useEffect(() => {
    if (!detail) return;
    const courseId = detail.round.courseId;
    fetch(`${baseUrl}/api/public/courses/${courseId}/holes-gps`)
      .then(r => r.ok ? r.json() : [])
      .then((data: CourseHoleGps[]) => { if (Array.isArray(data)) setHolesGps(data); })
      .catch(() => {});
  }, [detail?.round.courseId]);

  // Get user location once for GPS distance display
  useEffect(() => {
    Location.requestForegroundPermissionsAsync()
      .then(({ status }) => {
        if (status !== "granted") return;
        return Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      })
      .then(loc => {
        if (loc) { setUserLat(loc.coords.latitude); setUserLng(loc.coords.longitude); }
      })
      .catch(() => {});
  }, []);

  // Fetch weather when we have green GPS
  useEffect(() => {
    const holeGps = holesGps.find(h => h.holeNumber === currentHole);
    if (!holeGps?.greenCentreLat || !holeGps?.greenCentreLng) return;
    const lat = parseFloat(holeGps.greenCentreLat);
    const lng = parseFloat(holeGps.greenCentreLng);
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current_weather=true&wind_speed_unit=kmh`)
      .then(r => r.json())
      .then((d: { current_weather?: { windspeed: number; winddirection: number; temperature: number; weathercode: number } }) => {
        if (d.current_weather) {
          setWeather({ windSpeed: d.current_weather.windspeed, windDirection: d.current_weather.winddirection, temperature: d.current_weather.temperature, weatherCode: d.current_weather.weathercode });
        }
      })
      .catch(() => {});
  }, [currentHole, holesGps]);

  useEffect(() => {
    if (!token) return;
    fetch(`${baseUrl}/api/portal/my-stats`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then((data: { hcpTrend?: { handicapIndex: number }[] } | null) => {
        if (data?.hcpTrend?.length) {
          const hi = data.hcpTrend[data.hcpTrend.length - 1].handicapIndex;
          setCourseHandicap(hi); // store raw float — rounding happens at WHS CH formula
        }
      })
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    if (!detail) return;
    const existing = detail.holes.find(h => h.holeNumber === currentHole);
    if (existing) { setStrokes(existing.strokes); return; }
    const ch = detail.courseHoles.find(h => h.holeNumber === currentHole);
    if (ch) setStrokes(ch.par ?? 4);
  }, [currentHole, detail]);

  async function saveHole() {
    setSaving(true);
    const ch = detail?.courseHoles.find(h => h.holeNumber === currentHole);
    try {
      const res = await fetch(`${baseUrl}/api/portal/general-play/${id}/hole`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          holeNumber: currentHole,
          strokes,
          par: ch?.par ?? null,
          strokeIndex: ch?.handicap ?? null,
        }),
      });
      if (!res.ok) { Alert.alert("Failed to save"); return; }
      setDetail(prev => {
        if (!prev) return prev;
        const updated = prev.holes.filter(h => h.holeNumber !== currentHole);
        updated.push({ holeNumber: currentHole, strokes, par: ch?.par ?? null, strokeIndex: ch?.handicap ?? null });
        return { ...prev, holes: updated };
      });
      const totalHoles = detail?.round.holesPlayed ?? 18;
      if (currentHole < totalHoles) setCurrentHole(h => h + 1);
    } finally { setSaving(false); }
  }

  async function submitRound(fallbackMarkerName?: string) {
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {};
      if (fallbackMarkerName) {
        body.markerName = fallbackMarkerName;
      }
      const res = await fetch(`${baseUrl}/api/portal/general-play/${id}/submit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        // If API says markerName is required (legacy round without pre-assigned marker), ask for it
        if (errData?.error?.includes("markerName")) {
          Alert.prompt(
            "Marker Name Required",
            "This round has no pre-assigned marker. Enter your marker's name:",
            name => { if (name?.trim()) submitRound(name.trim()); },
            "plain-text",
          );
        } else {
          Alert.alert("Failed to submit", errData?.error ?? "Please try again.");
        }
        return;
      }

      Alert.alert(
        "Submitted!",
        detail?.markers[0]?.markerName
          ? `Your scorecard has been sent to ${detail.markers[0].markerName} for countersign.`
          : "Your round has been sent to your marker for countersign.",
      );
      load();
    } finally { setSubmitting(false); }
  }

  function confirmSubmit() {
    if (!detail) return;
    const markerName = detail.markers[0]?.markerName;
    Alert.alert(
      "Submit Scorecard",
      markerName
        ? `Submit your round for ${markerName} to countersign?`
        : "Submit your round for marker countersign?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Submit", onPress: () => submitRound() },
      ],
    );
  }

  if (loading || !detail) {
    return (
      <SafeAreaView style={styles.container}>
        <LoadingSpinner color={GOLD} style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }

  const totalHoles = detail.round.holesPlayed;
  const currentCH = detail.courseHoles.find(h => h.holeNumber === currentHole);
  const existingScore = detail.holes.find(h => h.holeNumber === currentHole);
  const scoredCount = detail.holes.length;
  const allScored = scoredCount >= totalHoles;
  const isEditable = detail.round.status === "draft" || detail.round.status === "in_progress";

  const toPar = existingScore && currentCH ? existingScore.strokes - currentCH.par : null;
  const currentToPar = currentCH?.par ? strokes - currentCH.par : null;
  const totalGross = detail.holes.reduce((s, h) => s + h.strokes, 0);

  // Derive proper Course Handicap using WHS formula when course data is available
  const rawHI = courseHandicap; // courseHandicap state stores the player's raw HI (from my-stats)
  const cr = detail.courseRating ?? null;
  const sl = detail.courseSlope ?? 113;
  const cp = detail.coursePar ?? null;
  const derivedCH: number | null =
    rawHI !== null && cr !== null && cp !== null
      ? Math.round(rawHI * (sl / 113) + (cr - cp))
      : rawHI !== null
      ? Math.round(rawHI)
      : null;

  // WHS per-hole stroke allowance & NDB cap
  const currentSI = currentCH?.handicap ?? 0;
  const ch = derivedCH ?? 0;
  const strokesReceived = currentSI > 0 && ch > 0
    ? ch >= 18 + currentSI ? 2 : ch >= currentSI ? 1 : 0
    : 0;
  const currentPar = currentCH?.par ?? 0;
  const ndbCap = currentPar > 0 ? currentPar + 2 + strokesReceived : null;
  const isAtCap = ndbCap !== null && strokes >= ndbCap;
  const hasParConfigured = currentPar > 0;

  // Setup warning: check if any holes are missing par data
  const hasMissingParHoles = detail.courseHoles.some(h => !h.par || h.par === 0);

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ padding: 4 }}>
          <Feather name="chevron-left" size={24} color={Colors.text} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerStatus}>
            {detail.round.status === "pending_marker" ? "⏳ Awaiting Marker" :
             detail.round.status === "confirmed" ? "✅ Confirmed" :
             `${scoredCount}/${totalHoles} holes scored`}
          </Text>
          {detail.markers[0] && (
            <Text style={styles.markerBadge}>Marker: {detail.markers[0].markerName}</Text>
          )}
        </View>
        {isEditable && allScored && (
          <TouchableOpacity style={styles.submitBtn} onPress={confirmSubmit} disabled={submitting}>
            <Text style={styles.submitBtnText}>{submitting ? "..." : "Submit"}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Confirmed banner */}
      {detail.round.status === "confirmed" && detail.round.scoreDifferential && (
        <View style={styles.confirmedBanner}>
          <Feather name="check-circle" size={16} color="#22c55e" />
          <Text style={styles.confirmedText}>Differential: {Number(detail.round.scoreDifferential).toFixed(1)}</Text>
        </View>
      )}

      {/*
        Task #1350 — mobile parity for the web "Report a course data error"
        deep link added in Task #1174 (src/pages/courses.tsx). This is the
        course-level entry point — for per-hole errors players use the link
        inside the HoleMapSheet. Hidden when we can't build a valid URL
        (no EXPO_PUBLIC_DOMAIN configured) so the action never silently
        no-ops.
        Task #1615 — also forward `coursePar` (the value we're showing in
        the round summary) as `currentValue` so the portal form pre-fills
        both the "current" and "suggested" inputs and the player only edits
        the digit they want to change. Omitted when coursePar is null (some
        legacy rounds don't have it stored) so we never send a value the
        player didn't actually see.
      */}
      {detail.round.courseId && baseUrl ? (
        <Pressable
          onPress={() => {
            const url = buildCorrectionDeepLink({
              baseUrl,
              courseId: detail.round.courseId,
              field: 'par',
              currentValue: detail.coursePar,
            });
            Linking.openURL(url).catch(() => {});
          }}
          style={styles.reportCourseLink}
          hitSlop={6}
          accessibilityRole="link"
          accessibilityLabel="Report a course data error"
          testID="link-report-course"
        >
          <Feather name="alert-triangle" size={11} color="#FBBF24" />
          <Text style={styles.reportCourseLinkText}>Report a course data error</Text>
        </Pressable>
      ) : null}

      {/* Missing par warning for entire round setup */}
      {isEditable && hasMissingParHoles && (
        <View style={styles.noParWarning}>
          <Feather name="alert-triangle" size={14} color="#92400e" />
          <Text style={styles.noParWarningText}>Some holes are missing par data — those scores won't count for handicap.</Text>
        </View>
      )}

      {/* Pending marker banner */}
      {detail.round.status === "pending_marker" && detail.markers[0] && (
        <View style={styles.pendingBanner}>
          <Feather name="clock" size={14} color="#f59e0b" />
          <Text style={styles.pendingText}>
            Waiting for {detail.markers[0].markerName} to countersign
          </Text>
        </View>
      )}

      {isEditable ? (
        <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
          {/* Hole navigation */}
          <View style={styles.holeNav}>
            <TouchableOpacity
              style={styles.holeNavBtn}
              onPress={() => setCurrentHole(h => Math.max(1, h - 1))}
              disabled={currentHole <= 1}
            >
              <Feather name="chevron-left" size={24} color={currentHole <= 1 ? Colors.muted : Colors.text} />
            </TouchableOpacity>
            <View style={styles.holeCenter}>
              <Text style={styles.holeLabel}>HOLE</Text>
              <Text style={styles.holeNumber}>{currentHole}</Text>
              {currentCH && (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, justifyContent: "center" }}>
                  <Text style={styles.holeMeta}>
                    {hasParConfigured ? `Par ${currentCH.par}` : "Par —"}
                    {currentCH.handicap ? ` · SI ${currentCH.handicap}` : ""}
                  </Text>
                  {strokesReceived > 0 && (
                    <View style={styles.allowanceBadge}>
                      <Text style={styles.allowanceBadgeText}>+{strokesReceived}</Text>
                    </View>
                  )}
                </View>
              )}
            </View>
            <TouchableOpacity
              style={styles.holeNavBtn}
              onPress={() => setCurrentHole(h => Math.min(totalHoles, h + 1))}
              disabled={currentHole >= totalHoles}
            >
              <Feather name="chevron-right" size={24} color={currentHole >= totalHoles ? Colors.muted : Colors.text} />
            </TouchableOpacity>
          </View>

          {/* Missing par warning */}
          {!hasParConfigured && currentCH && (
            <View style={styles.noParWarning}>
              <Feather name="alert-triangle" size={14} color="#92400e" />
              <Text style={styles.noParWarningText}>Hole data not configured — scores will not count for handicap.</Text>
            </View>
          )}

          {/* Score entry */}
          <View style={styles.scoreCard}>
            <Text style={styles.scoreLabel}>Strokes</Text>
            <View style={styles.scoreControls}>
              <TouchableOpacity
                style={[styles.scoreBtn, strokes <= 1 && styles.scoreBtnDisabled]}
                onPress={() => setStrokes(s => Math.max(1, s - 1))}
                disabled={strokes <= 1}
              >
                <Feather name="minus" size={24} color={Colors.text} />
              </TouchableOpacity>
              <View style={{ alignItems: "center" }}>
                <Text style={styles.scoreValue}>{strokes}</Text>
                {isAtCap && (
                  <View style={styles.maxBadge}>
                    <Text style={styles.maxBadgeText}>MAX</Text>
                  </View>
                )}
              </View>
              <TouchableOpacity
                style={[styles.scoreBtn, strokes >= 15 && styles.scoreBtnDisabled, isAtCap && { opacity: 0.4 }]}
                onPress={() => {
                  const next = strokes + 1;
                  if (ndbCap !== null && next >= ndbCap) {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
                  } else {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                  }
                  setStrokes(s => Math.min(15, s + 1));
                }}
                disabled={strokes >= 15}
              >
                <Feather name="plus" size={24} color={isAtCap ? Colors.muted : Colors.text} />
              </TouchableOpacity>
            </View>

            {/* To-par */}
            {currentToPar !== null && currentCH && hasParConfigured && (
              <Text style={[styles.toPar, { color: currentToPar < 0 ? "#f87171" : currentToPar === 0 ? Colors.muted : "#60a5fa" }]}>
                {currentToPar === 0 ? "Par" : currentToPar === -1 ? "Birdie" : currentToPar === -2 ? "Eagle" : currentToPar === 1 ? "Bogey" : currentToPar > 0 ? `+${currentToPar}` : `${currentToPar}`}
              </Text>
            )}

            <TouchableOpacity style={styles.saveBtn} onPress={saveHole} disabled={saving}>
              <Text style={styles.saveBtnText}>
                {saving ? "Saving..." : existingScore ? "Update" : currentHole < totalHoles ? "Save & Next →" : "Save"}
              </Text>
            </TouchableOpacity>

            {/* Shot tracking toggle */}
            <TouchableOpacity style={styles.shotTrackBtn} onPress={() => setShowShotPanel(p => !p)}>
              <Feather name="crosshair" size={13} color={Colors.secondary} />
              <Text style={styles.shotTrackBtnText}>
                Track Shot{(shotsByHole[currentHole] ?? 0) > 0 ? ` (${shotsByHole[currentHole]})` : ""}
              </Text>
            </TouchableOpacity>

            {/* Map button */}
            {holesGps.length > 0 && (
              <TouchableOpacity style={styles.mapBtn} onPress={() => setShowMap(true)}>
                <Feather name="map" size={14} color={GOLD} />
                <Text style={styles.mapBtnText}>Hole Map</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Shot panel */}
          {showShotPanel && (
            <View style={styles.shotPanel}>
              <Text style={styles.shotPanelTitle}>SHOT TYPE</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {["tee","fairway","approach","chip","sand","putt"].map(t => (
                  <Pressable key={t} onPress={() => setSelectedShotType(t)}
                    style={[styles.chip, selectedShotType === t && styles.chipActive]}>
                    <Text style={[styles.chipText, selectedShotType === t && { color: Colors.primary }]}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
              {/* Club picker: profile clubs first (bag), then remaining; AI suggestion from hole distance */}
              {(() => {
                const profileClubNames = clubProfile.map(e => e.club);
                const remaining = STANDARD_CLUBS.filter(c => !profileClubNames.includes(c));
                const orderedClubs = profileClubNames.length > 0 ? [...profileClubNames, ...remaining] : STANDARD_CLUBS;
                // AI suggestion: use current hole distance (metres → yards) against club profile
                const holeDist = detail?.courseHoles.find(h => h.holeNumber === currentHole)?.distance;
                const targetYds = holeDist ? Math.round(holeDist * 1.09361) : null;
                const suggested = targetYds && clubProfile.length > 0 ? (() => {
                  let best = clubProfile[0];
                  let bestDiff = Math.abs((best.avgDistance ?? 0) - targetYds);
                  for (const e of clubProfile) {
                    const d = Math.abs((e.avgDistance ?? 0) - targetYds);
                    if (d < bestDiff) { bestDiff = d; best = e; }
                  }
                  return bestDiff <= 60 ? best.club : null;
                })() : null;
                return (
                  <>
                    <Text style={styles.shotPanelTitle}>
                      {profileClubNames.length > 0 ? "CLUB (YOUR BAG)" : "CLUB"}
                      {suggested && !selectedClub ? ` · AI: ${suggested}` : ""}
                    </Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                      {orderedClubs.map(club => {
                        const inBag = profileClubNames.includes(club);
                        const isSuggested = suggested === club && !selectedClub;
                        const isSelected = selectedClub === club;
                        return (
                          <Pressable key={club} onPress={() => setSelectedClub(isSelected ? null : club)}
                            style={[
                              styles.chip,
                              isSelected && styles.chipActive,
                              isSuggested && { borderColor: "rgba(201,168,76,0.6)", borderWidth: 1.5 },
                              !inBag && profileClubNames.length > 0 && { opacity: 0.5 },
                            ]}>
                            <Text style={[styles.chipText, isSelected && { color: Colors.primary }]}>{club}</Text>
                            {isSuggested && <Text style={{ fontSize: 7, color: "#C9A84C", marginTop: 1 }}>AI ✦</Text>}
                          </Pressable>
                        );
                      })}
                    </ScrollView>
                  </>
                );
              })()}
              <Text style={styles.shotPanelTitle}>MISS DIRECTION</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {MISS_DIRECTIONS.map(d => (
                  <Pressable key={d} onPress={() => setSelectedMissDir(selectedMissDir === d ? null : d)}
                    style={[styles.chip, selectedMissDir === d && styles.chipActive]}>
                    <Text style={[styles.chipText, selectedMissDir === d && { color: Colors.primary }]}>{d}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <Text style={styles.shotPanelTitle}>LIE</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {LIE_TYPES.map(l => (
                  <Pressable key={l} onPress={() => setSelectedLieType(selectedLieType === l ? null : l)}
                    style={[styles.chip, selectedLieType === l && styles.chipActive]}>
                    <Text style={[styles.chipText, selectedLieType === l && { color: Colors.primary }]}>{l}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <Text style={styles.shotPanelTitle}>SHAPE</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {SHOT_SHAPES.map(s => (
                  <Pressable key={s} onPress={() => setSelectedShotShape(selectedShotShape === s ? null : s)}
                    style={[styles.chip, selectedShotShape === s && styles.chipActive]}>
                    <Text style={[styles.chipText, selectedShotShape === s && { color: Colors.primary }]}>{s}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <Text style={styles.shotPanelTitle}>PENALTY</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {PENALTY_REASONS.map(r => (
                  <Pressable key={r} onPress={() => setSelectedPenaltyReason(selectedPenaltyReason === r ? null : r)}
                    style={[styles.chip, selectedPenaltyReason === r && styles.chipActive]}>
                    <Text style={[styles.chipText, selectedPenaltyReason === r && { color: Colors.primary }]}>{r}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <TouchableOpacity style={styles.logShotBtn} onPress={handleLogShot}>
                <Feather name="plus-circle" size={15} color="#000" />
                <Text style={styles.logShotBtnText}>
                  Log Shot{selectedClub ? ` · ${selectedClub}` : ""}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Hole dots */}
          <View style={styles.dotRow}>
            {Array.from({ length: totalHoles }, (_, i) => i + 1).map(h => {
              const sc = detail.holes.find(s => s.holeNumber === h);
              const ch = detail.courseHoles.find(c => c.holeNumber === h);
              const tp = sc && ch ? sc.strokes - ch.par : null;
              const isActive = h === currentHole;
              return (
                <TouchableOpacity
                  key={h}
                  onPress={() => setCurrentHole(h)}
                  style={[
                    styles.dot,
                    isActive && { borderWidth: 2, borderColor: GOLD },
                    sc ? { backgroundColor: tp !== null && tp < 0 ? "#ef444440" : tp === 0 ? "#ffffff20" : "#3b82f630" } : { backgroundColor: "#ffffff10" },
                  ]}
                >
                  <Text style={[styles.dotText, isActive && { color: GOLD }]}>{h}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {scoredCount > 0 && (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Running Total ({scoredCount} holes)</Text>
              <Text style={styles.totalValue}>{totalGross}</Text>
            </View>
          )}
        </ScrollView>
      ) : (
        <View style={styles.summaryCard}>
          <Text style={styles.summaryGross}>{detail.round.grossScore ?? totalGross}</Text>
          <Text style={styles.summaryLabel}>Gross Score</Text>
          {detail.round.scoreDifferential && (
            <View style={styles.summaryDiff}>
              <Text style={styles.summaryDiffLabel}>Score Differential</Text>
              <Text style={styles.summaryDiffValue}>{Number(detail.round.scoreDifferential).toFixed(1)}</Text>
            </View>
          )}
          <ShotSourceBadges breakdown={sourceBreakdown} />
        </View>
      )}

      {/* Course Map Sheet */}
      {(() => {
        const holeGps = holesGps.find(h => h.holeNumber === currentHole);
        const holeInfo = {
          holeNumber: currentHole,
          par: currentCH?.par ?? null,
          yardageWhite: holeGps?.yardageWhite ?? currentCH?.distance ?? undefined,
          greenCentreLat: holeGps?.greenCentreLat ?? null,
          greenCentreLng: holeGps?.greenCentreLng ?? null,
          greenFrontLat: holeGps?.greenFrontLat ?? null,
          greenFrontLng: holeGps?.greenFrontLng ?? null,
          greenBackLat: holeGps?.greenBackLat ?? null,
          greenBackLng: holeGps?.greenBackLng ?? null,
        };
        return (
          <HoleMapSheet
            visible={showMap}
            onClose={() => setShowMap(false)}
            hole={holeInfo}
            userLat={userLat}
            userLng={userLng}
            weather={weather}
            courseId={detail?.round.courseId}
            generalPlayRoundId={parseInt(id ?? "0")}
            token={token}
          />
        );
      })()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12 },
  headerCenter: { flex: 1, alignItems: "center" },
  headerStatus: { color: Colors.muted, fontSize: 13 },
  markerBadge: { fontSize: 11, color: GOLD, marginTop: 2 },
  submitBtn: { backgroundColor: GOLD, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 6 },
  submitBtnText: { color: "#000", fontWeight: "700", fontSize: 13 },
  confirmedBanner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#22c55e15", marginHorizontal: 16, borderRadius: 8, padding: 10, marginBottom: 8 },
  confirmedText: { color: "#22c55e", fontSize: 13, fontWeight: "600" },
  // Task #1350 — course-level "Report an error" deep-link to the portal
  // correction form. Sits just under the round header.
  reportCourseLink: {
    flexDirection: "row", alignItems: "center", gap: 4,
    marginHorizontal: 16, marginBottom: 8,
    paddingVertical: 4,
  },
  reportCourseLinkText: {
    color: "rgba(251,191,36,0.85)", fontSize: 11, fontWeight: "600",
    textDecorationLine: "underline",
  },
  pendingBanner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#f59e0b15", marginHorizontal: 16, borderRadius: 8, padding: 10, marginBottom: 8 },
  pendingText: { color: "#f59e0b", fontSize: 13, fontWeight: "500" },
  scroll: { flex: 1 },
  holeNav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 24, paddingVertical: 20 },
  holeNavBtn: { padding: 8 },
  holeCenter: { alignItems: "center" },
  holeLabel: { fontSize: 11, color: Colors.muted, textTransform: "uppercase", letterSpacing: 1 },
  holeNumber: { fontSize: 56, fontWeight: "700", color: GOLD, lineHeight: 64 },
  holeMeta: { fontSize: 12, color: Colors.muted },
  scoreCard: { backgroundColor: Colors.surface, marginHorizontal: 16, borderRadius: 16, padding: 24, alignItems: "center" },
  scoreLabel: { fontSize: 12, color: Colors.muted, textTransform: "uppercase", letterSpacing: 1, marginBottom: 16 },
  scoreControls: { flexDirection: "row", alignItems: "center", gap: 32 },
  scoreBtn: { width: 52, height: 52, borderRadius: 26, borderWidth: 1, borderColor: Colors.border, alignItems: "center", justifyContent: "center" },
  scoreBtnDisabled: { opacity: 0.3 },
  scoreValue: { fontSize: 52, fontWeight: "700", color: Colors.text, minWidth: 60, textAlign: "center" },
  toPar: { marginTop: 12, fontSize: 16, fontWeight: "600" },
  saveBtn: { marginTop: 20, backgroundColor: GOLD, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 40 },
  saveBtnText: { color: "#000", fontWeight: "700", fontSize: 16 },
  mapBtn: { marginTop: 12, flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, borderColor: `${GOLD}50` },
  mapBtnText: { color: GOLD, fontSize: 13, fontWeight: "600" },
  dotRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "center", paddingHorizontal: 16, paddingVertical: 16 },
  dot: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  dotText: { fontSize: 11, fontWeight: "600", color: Colors.muted },
  totalRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginHorizontal: 16, backgroundColor: Colors.surface, borderRadius: 10, padding: 14, marginBottom: 16 },
  totalLabel: { color: Colors.muted, fontSize: 13 },
  totalValue: { color: Colors.text, fontSize: 18, fontWeight: "700" },
  summaryCard: { margin: 24, backgroundColor: Colors.surface, borderRadius: 16, padding: 32, alignItems: "center" },
  summaryGross: { fontSize: 64, fontWeight: "700", color: GOLD },
  summaryLabel: { color: Colors.muted, fontSize: 14, marginTop: 4 },
  summaryDiff: { marginTop: 20, alignItems: "center" },
  summaryDiffLabel: { color: Colors.muted, fontSize: 12 },
  summaryDiffValue: { color: Colors.text, fontSize: 28, fontWeight: "700" },
  modalBg: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modal: { backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20 },
  modalTitle: { fontSize: 18, fontWeight: "700", color: Colors.text, marginBottom: 8 },
  modalDesc: { color: Colors.muted, fontSize: 13, marginBottom: 16 },
  fieldLabel: { fontSize: 13, color: Colors.muted, fontWeight: "600", marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border, borderRadius: 8, padding: 12, color: Colors.text, fontSize: 14 },
  modalSummary: { flexDirection: "row", justifyContent: "space-between", backgroundColor: Colors.background, borderRadius: 8, padding: 12, marginTop: 16 },
  modalSummaryLabel: { color: Colors.muted, fontSize: 13 },
  modalSummaryValue: { color: Colors.text, fontWeight: "700", fontSize: 14 },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 20 },
  cancelBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, alignItems: "center" },
  cancelBtnText: { color: Colors.text, fontWeight: "600" },
  createBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: GOLD, alignItems: "center" },
  createBtnText: { color: "#000", fontWeight: "700" },
  noParWarning: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#fef3c7", borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: "#f59e0b", marginHorizontal: 16, marginBottom: 8 },
  noParWarningText: { flex: 1, fontSize: 12, color: "#92400e", fontWeight: "600" },
  allowanceBadge: { backgroundColor: `${GOLD}30`, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2, borderWidth: 1, borderColor: `${GOLD}60` },
  allowanceBadgeText: { fontSize: 11, color: GOLD, fontWeight: "700" },
  maxBadge: { backgroundColor: "#ef444420", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, borderWidth: 1, borderColor: "#ef444460", marginTop: 4 },
  maxBadgeText: { fontSize: 10, color: "#ef4444", fontWeight: "700", letterSpacing: 1 },
  shotTrackBtn: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 12, alignSelf: "center", paddingVertical: 6, paddingHorizontal: 14, borderRadius: 16, borderWidth: 1, borderColor: Colors.border },
  shotTrackBtnText: { fontSize: 12, color: Colors.secondary, fontWeight: "600" },
  shotPanel: { marginHorizontal: 16, marginBottom: 8, backgroundColor: Colors.surface, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: Colors.border },
  shotPanelTitle: { fontSize: 10, color: Colors.muted, fontWeight: "700", letterSpacing: 1, marginBottom: 6, marginTop: 8 },
  chipRow: { flexDirection: "row", gap: 6, paddingBottom: 2 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border, alignItems: "center" },
  chipActive: { backgroundColor: `${Colors.primary}20`, borderColor: Colors.primary },
  chipText: { fontSize: 12, color: Colors.textSecondary, fontWeight: "600" },
  logShotBtn: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: GOLD, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 16, marginTop: 12, justifyContent: "center" },
  logShotBtnText: { color: "#000", fontWeight: "700", fontSize: 13 },
});
