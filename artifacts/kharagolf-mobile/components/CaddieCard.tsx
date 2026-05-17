// AI Caddie recommendation card (Task #356)
//
// Fetches a ranked club recommendation + aim point from the backend, renders a
// compact card with an expandable "why this club" rationale, lets the player
// accept or override, and posts feedback so the model can learn.
//
// The card is fully usable offline: the latest recommendation per hole is
// cached in AsyncStorage and re-shown when the network is unavailable.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { fetchPortal, ConsentRequiredError } from "@/utils/api";
import { computeLocalRecommendation, loadSnapshot, sendOrQueueFeedback } from "@/utils/caddieOffline";
import { loadCachedCourseBundle, loadCachedCourseBundleForRound } from "@/utils/courseBundle";
import ConsentPrompt from "@/components/ConsentPrompt";

export interface AimPoint {
  latOffset: number;
  lngOffset: number;
  lateralStddevYards: number;
  longitudinalStddevYards: number;
  club: string | null;
}

export interface CaddieRecommendationData {
  recommendationId: number | null;
  distanceYards: number;
  effectiveDistance: number;
  windAdjustmentYards: number;
  headwindComponent: number;
  crosswindComponent: number;
  lateralStddevYards: number;
  aimOffsetYards: { forward: number; lateral: number };
  aimLatLngOffset: { lat: number; lng: number } | null;
  rankedClubs: Array<{
    club: string;
    carry: number;
    stddev: number;
    shotCount: number;
    source: "shots" | "manual" | "fallback";
    onGreenProb: number;
    surplusYards: number;
  }>;
  recommended: { club: string; carryYards: number; stddev: number; onGreenProb: number; shotCount: number } | null;
  alternate: { club: string; carryYards: number; stddev: number; onGreenProb: number; shotCount: number } | null;
  rationale: string[];
  usingFallback: boolean;
  missBiasLateralYards: number;
}

interface Props {
  token: string | null | undefined;
  /** Distance to pin in yards. Card hides if null. */
  distanceYards: number | null;
  /** Wind speed (km/h from weather). */
  windSpeedKmh?: number;
  /** Wind direction in degrees (meteorological — wind is FROM this bearing). */
  windDirectionDeg?: number;
  /** Bearing from player to pin in degrees (0=N). */
  bearingToPinDeg?: number | null;
  /** Pin latitude (used for aim point computation). */
  pinLat?: number | null;
  /** Elevation change to the green in yards (pin minus player). +ve = uphill. */
  elevationDeltaYards?: number | null;
  /** Player's current lie (e.g. "Tee", "Fairway", "Rough", "Bunker"). */
  lieType?: string | null;
  /** Hole context for persistence. */
  holeNumber: number;
  round?: number;
  tournamentId?: number | null;
  generalPlayRoundId?: number | null;
  /** Task #1160 — used to confirm a cached course bundle is available
   *  when the live `/caddie/recommend` call fails so we can label the
   *  card as running on saved offline data. */
  courseId?: number | null;
  /** Task #1586 — round-level "using cached course" signal, owned by the
   *  parent screen and shared with `<GpsDistanceRow />` and `<HoleMapSheet />`.
   *  When provided, this drives the "offline · saved course" pill so all
   *  three indicators flip together. Left undefined for legacy callers
   *  (e.g. tests), in which case the local `cachedCourseAvailable` probe
   *  is used as a fallback. */
  usingCachedCourse?: boolean;
  /** When the player accepts/overrides, the chosen club is reported here. */
  onClubChosen?: (club: string, accepted: boolean) => void;
  /** Aim point fed back to parent so the hole map overlay can render it. */
  onAimPointChange?: (aim: AimPoint | null) => void;
}

const CACHE_PREFIX = "kharagolf_caddie_rec_v1:";
function cacheKey(p: Pick<Props, "tournamentId" | "generalPlayRoundId" | "round" | "holeNumber"> & { distBucket: number; elevBucket: number; lieKey: string }) {
  const ctx = p.tournamentId ? `t${p.tournamentId}` : p.generalPlayRoundId ? `g${p.generalPlayRoundId}` : "x";
  return `${CACHE_PREFIX}${ctx}/r${p.round ?? 1}/h${p.holeNumber}/d${p.distBucket}/e${p.elevBucket}/l${p.lieKey}`;
}

export default function CaddieCard({
  token, distanceYards, windSpeedKmh = 0, windDirectionDeg = 0, bearingToPinDeg = null,
  pinLat = null, elevationDeltaYards = null, lieType = null,
  holeNumber, round = 1, tournamentId = null, generalPlayRoundId = null,
  courseId = null,
  usingCachedCourse,
  onClubChosen, onAimPointChange,
}: Props) {
  const [rec, setRec] = useState<CaddieRecommendationData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showWhy, setShowWhy] = useState(false);
  const [showOverride, setShowOverride] = useState(false);
  const [chosenClub, setChosenClub] = useState<string | null>(null);
  const [feedbackPosting, setFeedbackPosting] = useState(false);
  const [offline, setOffline] = useState(false);
  // Task #1160 — true once we've confirmed a cached course bundle exists
  // for this round, so the offline pill can switch from a generic "offline"
  // tag to "saved course" (i.e. distances/aim are still authoritative).
  // Task #1586 — kept only as a fallback for legacy callers that don't pass
  // the round-level `usingCachedCourse` prop (e.g. unit tests). Live
  // callers should rely on the prop so this card stays in sync with the
  // distance row + hole-map indicators.
  const [cachedCourseAvailable, setCachedCourseAvailable] = useState(false);
  // Task #1586 — prefer the round-level signal when the parent supplies it.
  const usingSavedCourse = usingCachedCourse ?? cachedCourseAvailable;
  // Held in a ref so the offline-fallback path inside `fetchRec` can decide
  // whether to run the local bundle probe without dragging the prop into
  // the useCallback's dep list (which would refetch on every flip).
  const usingCachedCourseRef = useRef(usingCachedCourse);
  useEffect(() => { usingCachedCourseRef.current = usingCachedCourse; }, [usingCachedCourse]);
  // Task #469 — surface a prompt when the API blocks AI suggestions because
  // the member has withdrawn their "ai" consent.
  const [consentBlock, setConsentBlock] = useState<{ category: string; message: string } | null>(null);

  // Distance is bucketed to 5y so we don't refetch on every GPS jitter.
  const distBucket = distanceYards != null ? Math.round(distanceYards / 5) * 5 : null;
  // Elevation bucketed to nearest 2y so small GPS noise doesn't refetch.
  const elevBucket = elevationDeltaYards != null ? Math.round(elevationDeltaYards / 2) * 2 : 0;
  const lieKey = lieType ? lieType.toLowerCase() : "";

  const fetchRec = useCallback(async () => {
    if (!token || distanceYards == null || distBucket == null) return;
    setLoading(true);
    setError(null);
    setOffline(false);
    try {
      // km/h → mph for the backend (its wind model is in mph).
      const windMph = windSpeedKmh / 1.60934;
      const params = new URLSearchParams({
        distanceYards: String(distBucket),
        windSpeed: String(windMph.toFixed(2)),
        windDirection: String(windDirectionDeg),
        windBearing: String(bearingToPinDeg ?? 0),
        round: String(round),
        holeNumber: String(holeNumber),
      });
      if (pinLat != null) params.set("pinLat", String(pinLat));
      if (bearingToPinDeg != null) params.set("bearingToPin", String(bearingToPinDeg));
      if (elevBucket !== 0) params.set("elevationDeltaYards", String(elevBucket));
      if (lieKey) params.set("lieType", lieKey);
      if (tournamentId) params.set("tournamentId", String(tournamentId));
      if (generalPlayRoundId) params.set("generalPlayRoundId", String(generalPlayRoundId));
      const data = await fetchPortal<CaddieRecommendationData>(`/caddie/recommend?${params.toString()}`, token);
      setRec(data);
      // Cache snapshot for offline replay.
      try {
        await AsyncStorage.setItem(
          cacheKey({ tournamentId, generalPlayRoundId, round, holeNumber, distBucket, elevBucket, lieKey }),
          JSON.stringify({ ...data, _cachedAt: Date.now() }),
        );
      } catch { /* non-fatal */ }
    } catch (e) {
      // Task #469 — when the backend blocks the call due to withdrawn AI
      // consent, surface an in-app prompt instead of falling through to the
      // offline cache (which would otherwise mask the policy decision).
      if (e instanceof ConsentRequiredError) {
        setConsentBlock({ category: e.category, message: e.message });
        setRec(null);
        setLoading(false);
        return;
      }
      // Offline path: try the per-bucket cache first, then fall back to the
      // cached round model snapshot to compute a fresh local recommendation.
      // Task #1160 — also confirm the offline course bundle is available so
      // the indicator can switch from a generic "offline" tag to a
      // "saved course" tag the player can trust for distances.
      // Task #1586 — skip the local probe when the parent has supplied the
      // round-level `usingCachedCourse` signal; that prop is the source of
      // truth shared with the distance row + hole-map indicators.
      if (usingCachedCourseRef.current === undefined) {
        try {
          const bundle = courseId
            ? await loadCachedCourseBundle(courseId)
            : await loadCachedCourseBundleForRound({ tournamentId, generalPlayRoundId });
          if (bundle) setCachedCourseAvailable(true);
        } catch { /* non-fatal */ }
      }
      try {
        const raw = await AsyncStorage.getItem(cacheKey({ tournamentId, generalPlayRoundId, round, holeNumber, distBucket, elevBucket, lieKey }));
        if (raw) {
          const cached = JSON.parse(raw) as CaddieRecommendationData;
          setRec(cached);
          setOffline(true);
        } else {
          const snap = await loadSnapshot(tournamentId, generalPlayRoundId, round);
          const local = snap ? computeLocalRecommendation({
            snapshot: snap,
            distanceYards: distBucket,
            windSpeedMph: windSpeedKmh / 1.60934,
            windDirectionDeg,
            windBearingDeg: bearingToPinDeg ?? 0,
            pinLat,
            bearingToPinDeg,
            elevationDeltaYards: elevBucket,
            lieType: lieKey || null,
          }) : null;
          if (local) {
            setRec(local as unknown as CaddieRecommendationData);
            setOffline(true);
          } else {
            setError("Recommendation unavailable");
          }
        }
      } catch {
        setError("Recommendation unavailable");
      }
    } finally {
      setLoading(false);
    }
  }, [token, distBucket, windSpeedKmh, windDirectionDeg, bearingToPinDeg, pinLat, elevBucket, lieKey, tournamentId, generalPlayRoundId, round, holeNumber, distanceYards, courseId]);

  useEffect(() => { fetchRec(); }, [fetchRec]);

  // Reset chosen club when hole or distance bucket changes.
  useEffect(() => { setChosenClub(null); setShowOverride(false); setShowWhy(false); }, [holeNumber, distBucket]);

  // Push aim point to parent (so HoleMapSheet can render it).
  useEffect(() => {
    if (!rec || !rec.aimLatLngOffset) { onAimPointChange?.(null); return; }
    onAimPointChange?.({
      latOffset: rec.aimLatLngOffset.lat,
      lngOffset: rec.aimLatLngOffset.lng,
      lateralStddevYards: rec.lateralStddevYards,
      longitudinalStddevYards: rec.recommended?.stddev ?? rec.lateralStddevYards,
      club: rec.recommended?.club ?? null,
    });
  }, [rec, onAimPointChange]);

  const postFeedback = useCallback(async (club: string) => {
    if (!token || !rec?.recommended) return;
    const accepted = club === rec.recommended.club;
    onClubChosen?.(club, accepted);
    // Locally-computed offline recommendations have no server id to attach
    // feedback to, so we skip the queue in that case.
    if (!rec.recommendationId) return;
    setFeedbackPosting(true);
    try {
      await sendOrQueueFeedback(token, {
        recommendationId: rec.recommendationId,
        chosenClub: club,
        accepted,
      });
    } finally {
      setFeedbackPosting(false);
    }
  }, [token, rec, onClubChosen]);

  const handlePick = (club: string) => {
    setChosenClub(club);
    setShowOverride(false);
    postFeedback(club);
  };

  const confidencePct = useMemo(() => rec?.recommended ? Math.round(rec.recommended.onGreenProb * 100) : null, [rec]);

  if (distanceYards == null) return null;
  if (consentBlock) {
    return (
      <ConsentPrompt
        message={consentBlock.message}
        category={consentBlock.category}
        onDismiss={() => setConsentBlock(null)}
      />
    );
  }
  if (loading && !rec) {
    return (
      <View style={s.card}>
        <View style={s.headerRow}>
          <Text style={s.brand}>🤖 AI CADDIE</Text>
          <ActivityIndicator size="small" color="#C9A84C" />
        </View>
      </View>
    );
  }
  if (error && !rec) return null;
  if (!rec || !rec.recommended) return null;

  const r = rec.recommended;
  return (
    <View style={s.card}>
      <View style={s.headerRow}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={s.brand}>🤖 AI CADDIE</Text>
          {rec.usingFallback && <Text style={s.fallbackTag}>est.</Text>}
          {offline && (
            <Text style={s.fallbackTag}>
              {usingSavedCourse ? "offline · saved course" : "offline"}
            </Text>
          )}
        </View>
        {confidencePct != null && (
          <View style={[s.confPill, confidencePct >= 60 ? s.confHigh : confidencePct >= 35 ? s.confMid : s.confLow]}>
            <Text style={s.confText}>{confidencePct}% on target</Text>
          </View>
        )}
      </View>

      <View style={s.mainRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.label}>Recommended</Text>
          <Text style={s.clubName}>{chosenClub ?? r.club}</Text>
          <Text style={s.clubMeta}>
            {r.carryYards}y carry · ±{Math.round(r.stddev)}y
            {r.shotCount >= 5 ? ` · ${r.shotCount} tracked` : ""}
          </Text>
        </View>
        <View style={s.distBlock}>
          <Text style={s.label}>Plays</Text>
          <Text style={s.distVal}>{rec.effectiveDistance}<Text style={s.distUnit}>y</Text></Text>
          {rec.windAdjustmentYards !== 0 && (
            <Text style={[s.windAdj, { color: rec.windAdjustmentYards > 0 ? "#f87171" : "#4ade80" }]}>
              {rec.windAdjustmentYards > 0 ? `+${rec.windAdjustmentYards}y` : `${rec.windAdjustmentYards}y`}
            </Text>
          )}
        </View>
      </View>

      {/* Aim hint */}
      {(Math.abs(rec.aimOffsetYards.lateral) > 1 || Math.abs(rec.aimOffsetYards.forward) > 1) && (
        <View style={s.aimRow}>
          <Feather name="crosshair" size={11} color="#C9A84C" />
          <Text style={s.aimText}>
            Aim {Math.abs(rec.aimOffsetYards.lateral) > 1 ? `${Math.abs(Math.round(rec.aimOffsetYards.lateral))}y ${rec.aimOffsetYards.lateral > 0 ? "right" : "left"}` : "on pin"}
            {Math.abs(rec.aimOffsetYards.forward) > 1 ? `, ${Math.abs(Math.round(rec.aimOffsetYards.forward))}y short` : ""}
          </Text>
        </View>
      )}

      {/* Action row */}
      <View style={s.actionsRow}>
        <Pressable
          onPress={() => { setShowWhy(v => !v); }}
          style={s.whyBtn}
          accessibilityLabel="Toggle recommendation rationale"
        >
          <Feather name={showWhy ? "chevron-up" : "info"} size={11} color="#C9A84C" />
          <Text style={s.whyText}>{showWhy ? "Hide" : "Why this club?"}</Text>
        </Pressable>
        {!chosenClub ? (
          <View style={{ flexDirection: "row", gap: 6 }}>
            <Pressable
              onPress={() => handlePick(r.club)}
              style={[s.acceptBtn, feedbackPosting && { opacity: 0.6 }]}
              disabled={feedbackPosting}
            >
              <Feather name="check" size={11} color="#000" />
              <Text style={s.acceptText}>Accept</Text>
            </Pressable>
            <Pressable
              onPress={() => setShowOverride(v => !v)}
              style={s.overrideBtn}
            >
              <Feather name="repeat" size={11} color="#C9A84C" />
              <Text style={s.overrideText}>Override</Text>
            </Pressable>
          </View>
        ) : (
          <View style={s.chosenPill}>
            <Feather name="check-circle" size={11} color="#4ade80" />
            <Text style={s.chosenText}>Logged</Text>
          </View>
        )}
      </View>

      {/* Why expanded */}
      {showWhy && (
        <View style={s.whyPanel}>
          {rec.rationale.map((line, i) => (
            <View key={i} style={s.whyLine}>
              <Text style={s.whyBullet}>•</Text>
              <Text style={s.whyLineText}>{line}</Text>
            </View>
          ))}
          {rec.rankedClubs.length > 1 && (
            <View style={{ marginTop: 6 }}>
              <Text style={s.whySectionLbl}>Top picks</Text>
              {rec.rankedClubs.map((rc, i) => (
                <View key={rc.club} style={s.rankRow}>
                  <Text style={[s.rankIdx, i === 0 && { color: "#C9A84C" }]}>{i + 1}</Text>
                  <Text style={[s.rankClub, i === 0 && { color: "#fff", fontWeight: "700" }]}>{rc.club}</Text>
                  <Text style={s.rankCarry}>{rc.carry}y</Text>
                  <Text style={s.rankProb}>{Math.round(rc.onGreenProb * 100)}%</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      )}

      {/* Override picker */}
      {showOverride && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.overrideRow}>
          {rec.rankedClubs.map(rc => (
            <Pressable
              key={rc.club}
              onPress={() => handlePick(rc.club)}
              style={s.overrideChip}
            >
              <Text style={s.overrideChipText}>{rc.club}</Text>
              <Text style={s.overrideChipMeta}>{rc.carry}y · {Math.round(rc.onGreenProb * 100)}%</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: "rgba(201,168,76,0.10)",
    borderRadius: 12,
    padding: 10,
    marginHorizontal: 16,
    marginTop: 8,
    borderWidth: 1,
    borderColor: "rgba(201,168,76,0.30)",
  },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  brand: { fontSize: 11, fontWeight: "700", color: "#C9A84C", letterSpacing: 0.5 },
  fallbackTag: { fontSize: 9, color: "rgba(201,168,76,0.7)", textTransform: "uppercase", borderColor: "rgba(201,168,76,0.4)", borderWidth: 1, paddingHorizontal: 4, borderRadius: 3 },
  confPill: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8 },
  confHigh: { backgroundColor: "rgba(74,222,128,0.18)" },
  confMid: { backgroundColor: "rgba(251,191,36,0.18)" },
  confLow: { backgroundColor: "rgba(248,113,113,0.18)" },
  confText: { color: "#fff", fontSize: 10, fontWeight: "700" },
  mainRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" },
  label: { color: "rgba(255,255,255,0.55)", fontSize: 10, textTransform: "uppercase", marginBottom: 2 },
  clubName: { color: "#C9A84C", fontSize: 19, fontWeight: "800" },
  clubMeta: { color: "rgba(255,255,255,0.55)", fontSize: 11, marginTop: 1 },
  distBlock: { alignItems: "flex-end" },
  distVal: { color: "#fff", fontSize: 18, fontWeight: "700" },
  distUnit: { fontSize: 11, opacity: 0.6 },
  windAdj: { fontSize: 11, fontWeight: "600" },
  aimRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  aimText: { color: "rgba(201,168,76,0.85)", fontSize: 11 },
  actionsRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 },
  whyBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 4 },
  whyText: { color: "#C9A84C", fontSize: 11, fontWeight: "600" },
  acceptBtn: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#C9A84C", paddingHorizontal: 9, paddingVertical: 5, borderRadius: 6 },
  acceptText: { color: "#000", fontSize: 11, fontWeight: "700" },
  overrideBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: "rgba(201,168,76,0.5)" },
  overrideText: { color: "#C9A84C", fontSize: 11, fontWeight: "600" },
  chosenPill: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4 },
  chosenText: { color: "#4ade80", fontSize: 11, fontWeight: "600" },
  whyPanel: { marginTop: 8, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(201,168,76,0.25)" },
  whyLine: { flexDirection: "row", gap: 6, marginBottom: 3 },
  whyBullet: { color: "#C9A84C", fontSize: 11 },
  whyLineText: { color: "rgba(255,255,255,0.85)", fontSize: 11, flex: 1, lineHeight: 15 },
  whySectionLbl: { color: "rgba(255,255,255,0.5)", fontSize: 10, fontWeight: "700", textTransform: "uppercase", marginTop: 6, marginBottom: 4 },
  rankRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 2 },
  rankIdx: { color: "rgba(255,255,255,0.4)", fontSize: 11, width: 14, fontWeight: "700" },
  rankClub: { color: "rgba(255,255,255,0.75)", fontSize: 12, flex: 1 },
  rankCarry: { color: "rgba(255,255,255,0.55)", fontSize: 11, width: 40, textAlign: "right" },
  rankProb: { color: "rgba(201,168,76,0.85)", fontSize: 11, width: 36, textAlign: "right", fontWeight: "600" },
  overrideRow: { gap: 6, paddingTop: 8, paddingHorizontal: 2 },
  overrideChip: { backgroundColor: "rgba(255,255,255,0.06)", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: "rgba(201,168,76,0.3)" },
  overrideChipText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  overrideChipMeta: { color: "rgba(255,255,255,0.5)", fontSize: 10, marginTop: 1 },
});
