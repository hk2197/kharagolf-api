import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  FlatList,
  Modal,
  Vibration,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as Location from "expo-location";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import Colors from "@/constants/colors";
import { translateLieType } from "@/i18n/lieType";

const SHOT_TYPES = ["tee", "fairway", "approach", "chip", "sand", "putt"] as const;
type ShotType = typeof SHOT_TYPES[number];
const LIE_TYPES = ["tee", "fairway", "rough", "sand", "green", "recovery"] as const;
const CLUBS = ["Dr", "3W", "5W", "Hy", "3i", "4i", "5i", "6i", "7i", "8i", "9i", "PW", "GW", "SW", "LW", "Pt"] as const;

const GOLD = "#C9A84C";

interface ScorerGroup {
  groupId: number;
  players: Array<{ playerId: number; name: string; handicapIndex: string | null }>;
  startHole: number;
  teeTime: string | null;
}

interface CourseHole {
  holeNumber: number;
  par: number;
  handicap: number | null;
  distance: number | null;
}

interface LoggedShot {
  id: number;
  playerId: number;
  round: number;
  holeNumber: number;
  shotNumber: number;
  shotType: ShotType;
  club: string | null;
  lieType: string | null;
  missDirection: string | null;
  shotShape: string | null;
  penaltyReason: string | null;
  latitude: string | null;
  longitude: string | null;
  distanceToPin: string | null;
  distanceCarried: string | null;
  source: string;
}

interface GroupDetail extends ScorerGroup {
  scores: Array<{ playerId: number; holeNumber: number; strokes: number }>;
  shots: LoggedShot[];
  currentHole: number;
  tournamentId: number;
  courseId: number;
}

type Screen = "select-tournament" | "group-list" | "scoring";

interface Tournament {
  id: number;
  name: string;
  status: string;
  currentRound: number | null;
  format?: string | null;
  maxScoreCap?: number | null;
  cutAfterRound?: number | null;
}

interface LocalRulesConfig {
  preferredLies?: boolean;
  preferredLiesRadius?: string;
  preferredLiesArea?: string;
  reducedEsc?: boolean;
  reducedEscMax?: number;
  liftCleanPlace?: boolean;
  dropZones?: string;
  additionalNotes?: string;
}

export default function ScorerStationScreen() {
  const { token } = useAuth();
  const { activeClub } = useActiveClub();
  const { t } = useTranslation("scoring");
  const { t: tProfile } = useTranslation("profile");
  const orgId = activeClub?.id;
  const baseUrl = process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
    : "";

  const [screen, setScreen] = useState<Screen>("select-tournament");
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [selectedTournament, setSelectedTournament] = useState<Tournament | null>(null);
  const [groups, setGroups] = useState<ScorerGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<GroupDetail | null>(null);
  const [courseHoles, setCourseHoles] = useState<CourseHole[]>([]);
  const [currentHole, setCurrentHole] = useState(1);
  const [pendingScores, setPendingScores] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localRules, setLocalRules] = useState<string | null>(null);
  const [localRulesConfig, setLocalRulesConfig] = useState<LocalRulesConfig | null>(null);
  const [localRulesBannerOpen, setLocalRulesBannerOpen] = useState(true);

  // Shot logging state
  const [shotModalPlayer, setShotModalPlayer] = useState<{ playerId: number; name: string } | null>(null);
  const [shotHole, setShotHole] = useState<number>(1);
  const [shotNumber, setShotNumber] = useState<number>(1);
  const [shotType, setShotType] = useState<ShotType>("tee");
  const [shotClub, setShotClub] = useState<string | null>(null);
  const [shotLie, setShotLie] = useState<string | null>(null);
  const [shotCoords, setShotCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [shotGpsLoading, setShotGpsLoading] = useState(false);
  const [shotSubmitting, setShotSubmitting] = useState(false);
  const [shotCounts, setShotCounts] = useState<Record<string, number>>({});
  const [editingShotId, setEditingShotId] = useState<number | null>(null);

  async function loadTournaments() {
    if (!orgId || !token) return;
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/public/tournaments?organizationId=${orgId}&status=active`);
      if (res.ok) setTournaments(await res.json());
    } finally { setLoading(false); }
  }

  async function loadGroups(tournament: Tournament) {
    if (!orgId || !token) return;
    setLoading(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/scorer/groups?tournamentId=${tournament.id}&organizationId=${orgId}&round=${tournament.currentRound ?? 1}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.ok) {
        setGroups(await res.json());
        setScreen("group-list");
      } else {
        Alert.alert(t("failedToLoadGroups"));
      }
    } finally { setLoading(false); }
  }

  async function loadGroup(groupId: number) {
    if (!selectedTournament || !token) return;
    setLoading(true);
    try {
      const [groupRes, holesRes] = await Promise.all([
        fetch(`${baseUrl}/api/scorer/groups/${groupId}?tournamentId=${selectedTournament.id}&round=${selectedTournament.currentRound ?? 1}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${baseUrl}/api/scorer/course-holes?tournamentId=${selectedTournament.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      if (!groupRes.ok) { Alert.alert(t("failedToLoadGroup")); return; }
      const gdRaw = await groupRes.json();
      const gd: GroupDetail = { ...gdRaw, shots: Array.isArray(gdRaw.shots) ? gdRaw.shots : [] };
      const holesResponse = holesRes.ok ? await holesRes.json() : { holes: [], localRules: null, localRulesConfig: null };
      const holes: CourseHole[] = Array.isArray(holesResponse) ? holesResponse : (holesResponse.holes ?? []);
      // Seed per-(player, hole) shot counter from server so "Shot #" pre-fills correctly.
      const seededCounts: Record<string, number> = {};
      gd.shots.forEach(s => {
        const k = `${s.playerId}-${s.holeNumber}`;
        seededCounts[k] = Math.max(seededCounts[k] ?? 0, s.shotNumber);
      });
      setShotCounts(seededCounts);
      setSelectedGroup(gd);
      setCourseHoles(holes);
      setLocalRules(Array.isArray(holesResponse) ? null : (holesResponse.localRules ?? null));
      setLocalRulesConfig(Array.isArray(holesResponse) ? null : (holesResponse.localRulesConfig ?? null));

      const existingHoles = new Set(gd.scores.map(s => s.holeNumber));
      let firstUnscored = gd.startHole ?? 1;
      for (let h = 1; h <= 18; h++) {
        if (!existingHoles.has(h)) { firstUnscored = h; break; }
      }
      setCurrentHole(firstUnscored);

      const initial: Record<number, number> = {};
      gd.players.forEach(p => {
        const ch = holes.find(h => h.holeNumber === firstUnscored);
        initial[p.playerId] = ch?.par ?? 4;
      });
      setPendingScores(initial);
      setScreen("scoring");
    } finally { setLoading(false); }
  }

  useEffect(() => { loadTournaments(); }, [orgId, token]);

  const currentCH = courseHoles.find(h => h.holeNumber === currentHole);

  function changeScore(playerId: number, delta: number) {
    Vibration.vibrate(10);
    setPendingScores(prev => ({
      ...prev,
      [playerId]: Math.max(1, Math.min(15, (prev[playerId] ?? 4) + delta)),
    }));
  }

  async function saveHoleAndAdvance() {
    if (!selectedGroup || !token || !selectedTournament) return;
    setSubmitting(true);
    try {
      const updates = Object.entries(pendingScores).map(([playerId, strokes]) => ({
        playerId: parseInt(playerId),
        strokes,
        holeNumber: currentHole,
        par: currentCH?.par ?? null,
        strokeIndex: currentCH?.handicap ?? null,
      }));

      const results = await Promise.all(
        updates.map(u =>
          fetch(`${baseUrl}/api/scorer/groups/${selectedGroup.groupId}/score`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              ...u,
              tournamentId: selectedTournament.id,
              round: selectedTournament.currentRound ?? 1,
            }),
          })
        )
      );

      const allOk = results.every(r => r.ok);
      if (!allOk) { Alert.alert(t("someScoresFailed")); return; }

      if (currentHole < 18) {
        const nextHole = currentHole + 1;
        setCurrentHole(nextHole);
        const nextCH = courseHoles.find(h => h.holeNumber === nextHole);
        const newScores: Record<number, number> = {};
        selectedGroup.players.forEach(p => {
          const ex = selectedGroup.scores.find(s => s.playerId === p.playerId && s.holeNumber === nextHole);
          newScores[p.playerId] = ex?.strokes ?? nextCH?.par ?? 4;
        });
        setPendingScores(newScores);

        setSelectedGroup(prev => {
          if (!prev) return prev;
          const filtered = prev.scores.filter(s => !(updates.map(u => u.playerId).includes(s.playerId) && s.holeNumber === currentHole));
          return { ...prev, scores: [...filtered, ...updates.map(u => ({ playerId: u.playerId, holeNumber: currentHole, strokes: u.strokes }))] };
        });
      } else {
        Alert.alert(t("scorecardCompleteTitle"), t("scorecardCompletePrompt"), [
          { text: t("notYet"), style: "cancel" },
          { text: t("submit"), onPress: submitScorecard },
        ]);
      }
    } finally { setSubmitting(false); }
  }

  function openShotModal(player: { playerId: number; name: string }) {
    const key = `${player.playerId}-${currentHole}`;
    const next = (shotCounts[key] ?? 0) + 1;
    const defaultType: ShotType =
      next === 1 ? "tee" : (currentCH?.par ?? 4) > 3 && next === 2 ? "approach" : "fairway";
    const defaultLie = next === 1 ? "tee" : "fairway";
    setEditingShotId(null);
    setShotModalPlayer(player);
    setShotHole(currentHole);
    setShotNumber(next);
    setShotType(defaultType);
    setShotClub(null);
    setShotLie(defaultLie);
    setShotCoords(null);
  }

  function openEditShotModal(player: { playerId: number; name: string }, shot: LoggedShot) {
    setEditingShotId(shot.id);
    setShotModalPlayer(player);
    setShotHole(shot.holeNumber);
    setShotNumber(shot.shotNumber);
    setShotType(shot.shotType);
    setShotClub(shot.club);
    setShotLie(shot.lieType);
    setShotCoords(
      shot.latitude != null && shot.longitude != null
        ? { lat: parseFloat(shot.latitude), lng: parseFloat(shot.longitude) }
        : null
    );
  }

  async function captureShotGps() {
    setShotGpsLoading(true);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") {
        Alert.alert(t("locationPermissionTitle"), t("locationPermissionBody"));
        return;
      }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
      setShotCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    } catch {
      Alert.alert(t("gpsErrorTitle"), t("gpsErrorBody"));
    } finally { setShotGpsLoading(false); }
  }

  async function submitShot() {
    if (!shotModalPlayer || !selectedGroup || !selectedTournament || !token) return;
    setShotSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        playerId: shotModalPlayer.playerId,
        holeNumber: shotHole,
        shotNumber,
        round: selectedTournament.currentRound ?? 1,
        shotType,
      };
      if (shotClub) body.club = shotClub;
      if (shotLie) body.lieType = shotLie;
      if (shotCoords) {
        body.latitude = shotCoords.lat;
        body.longitude = shotCoords.lng;
      }

      const res = await fetch(`${baseUrl}/api/scorer/groups/${selectedGroup.groupId}/shots`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        Alert.alert(t("failedToSaveShotTitle"), err.error ?? t("pleaseTryAgain"));
        return;
      }
      const payload = await res.json().catch(() => ({})) as { shot?: LoggedShot };
      const savedShot = payload.shot;
      const key = `${shotModalPlayer.playerId}-${shotHole}`;
      setShotCounts(prev => ({ ...prev, [key]: Math.max(prev[key] ?? 0, shotNumber) }));
      if (savedShot) {
        setSelectedGroup(prev => {
          if (!prev) return prev;
          const others = prev.shots.filter(s => !(
            s.playerId === savedShot.playerId &&
            s.round === savedShot.round &&
            s.holeNumber === savedShot.holeNumber &&
            s.shotNumber === savedShot.shotNumber
          ));
          const merged = [...others, savedShot].sort(
            (a, b) => a.holeNumber - b.holeNumber || a.shotNumber - b.shotNumber
          );
          return { ...prev, shots: merged };
        });
      }
      Vibration.vibrate(10);
      setShotModalPlayer(null);
      setEditingShotId(null);
    } finally { setShotSubmitting(false); }
  }

  async function deleteShot(shot: LoggedShot) {
    if (!selectedGroup || !selectedTournament || !token) return;
    try {
      const res = await fetch(
        `${baseUrl}/api/scorer/groups/${selectedGroup.groupId}/shots/${shot.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        Alert.alert(t("failedToDeleteShotTitle"), err.error ?? t("pleaseTryAgain"));
        return;
      }
      // Remove from the local list and recompute the per-(player, hole) counter
      // from the remaining shots so the next "Log shot" pre-fills correctly.
      setSelectedGroup(prev => {
        if (!prev) return prev;
        const remaining = prev.shots.filter(s => s.id !== shot.id);
        return { ...prev, shots: remaining };
      });
      setShotCounts(prev => {
        const key = `${shot.playerId}-${shot.holeNumber}`;
        const remainingForKey = (selectedGroup.shots ?? [])
          .filter(s => s.id !== shot.id && s.playerId === shot.playerId && s.holeNumber === shot.holeNumber)
          .map(s => s.shotNumber);
        const next = remainingForKey.length > 0 ? Math.max(...remainingForKey) : 0;
        return { ...prev, [key]: next };
      });
      Vibration.vibrate(10);
    } catch {
      Alert.alert(t("failedToDeleteShotTitle"), t("pleaseTryAgain"));
    }
  }

  function confirmDeleteShot(player: { playerId: number; name: string }, shot: LoggedShot) {
    Alert.alert(
      t("deleteShotTitle"),
      t("deleteShotBody", { name: player.name, shot: shot.shotNumber, hole: shot.holeNumber }),
      [
        { text: t("cancel"), style: "cancel" },
        { text: t("delete"), style: "destructive", onPress: () => deleteShot(shot) },
      ]
    );
  }

  async function submitScorecard() {
    if (!selectedGroup || !token || !selectedTournament) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${baseUrl}/api/scorer/groups/${selectedGroup.groupId}/submit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          tournamentId: selectedTournament.id,
          round: selectedTournament.currentRound ?? 1,
        }),
      });
      if (res.ok) {
        Alert.alert(t("scorecardSubmittedTitle"), t("scorecardSubmittedBody"));
        setScreen("group-list");
        loadGroups(selectedTournament);
      } else {
        Alert.alert(t("submissionFailedTitle"), t("submissionFailedBody"));
      }
    } finally { setSubmitting(false); }
  }

  const activeLocalRuleFlags: string[] = [
    ...(localRulesConfig?.preferredLies
      ? [
          `${t("localRule.preferredLies")}${localRulesConfig.preferredLiesRadius ? ` (${localRulesConfig.preferredLiesRadius.replace(/_/g, ' ')})` : ''}${
            localRulesConfig.preferredLiesArea === 'fairways_only'
              ? t("localRule.preferredLiesFairwaysOnlySuffix")
              : localRulesConfig.preferredLiesArea === 'through_green'
              ? t("localRule.preferredLiesThroughGreenSuffix")
              : ''
          }`,
        ]
      : []),
    ...(localRulesConfig?.liftCleanPlace ? [t("localRule.liftCleanPlace")] : []),
    ...(localRulesConfig?.reducedEsc
      ? [`${t("localRule.reducedEsc")}${localRulesConfig.reducedEscMax ? t("localRule.reducedEscMaxSuffix", { max: localRulesConfig.reducedEscMax }) : ''}`]
      : []),
    ...(localRulesConfig?.dropZones ? [t("localRule.dropZones", { zones: localRulesConfig.dropZones })] : []),
    ...(localRulesConfig?.additionalNotes ? [localRulesConfig.additionalNotes] : []),
  ];
  const hasLocalRules = activeLocalRuleFlags.length > 0 || !!localRules;

  if (screen === "select-tournament") {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={{ padding: 4 }}>
            <Feather name="chevron-left" size={24} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>{t("scorerStation")}</Text>
        </View>
        <Text style={styles.sectionLabel}>{t("selectActiveTournament")}</Text>
        {loading ? <LoadingSpinner color={GOLD} style={{ marginTop: 40 }} /> : (
          <ScrollView style={styles.scroll}>
            {tournaments.length === 0 ? (
              <View style={styles.emptyState}>
                <Feather name="flag" size={32} color={Colors.muted} />
                <Text style={styles.emptyText}>{t("noActiveTournaments")}</Text>
              </View>
            ) : (
              tournaments.map(tour => (
                <TouchableOpacity
                  key={tour.id}
                  style={styles.card}
                  onPress={() => { setSelectedTournament(tour); loadGroups(tour); }}
                >
                  <Text style={styles.cardTitle}>{tour.name}</Text>
                  <View style={styles.activeBadge}>
                    <Text style={styles.activeBadgeText}>{t("activeRoundBadge", { round: tour.currentRound ?? 1 })}</Text>
                  </View>
                </TouchableOpacity>
              ))
            )}
          </ScrollView>
        )}
      </SafeAreaView>
    );
  }

  if (screen === "group-list") {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => setScreen("select-tournament")} style={{ padding: 4 }}>
            <Feather name="chevron-left" size={24} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>{selectedTournament?.name}</Text>
        </View>
        <Text style={styles.sectionLabel}>{t("selectYourGroup")}</Text>
        {loading ? <LoadingSpinner color={GOLD} style={{ marginTop: 40 }} /> : (
          <FlatList
            data={groups}
            keyExtractor={g => String(g.groupId)}
            contentContainerStyle={{ padding: 16 }}
            renderItem={({ item: g }) => (
              <TouchableOpacity style={styles.card} onPress={() => loadGroup(g.groupId)}>
                <View style={styles.groupHeader}>
                  <Text style={styles.cardTitle}>
                    {g.teeTime ? t("teeTimeLabel", { time: g.teeTime.slice(11, 16) }) : t("groupLabel", { id: g.groupId })}
                  </Text>
                  <Text style={styles.startHole}>{t("startingHole", { hole: g.startHole ?? 1 })}</Text>
                </View>
                <View style={styles.playerList}>
                  {g.players.map(p => (
                    <Text key={p.playerId} style={styles.playerName}>
                      {p.name}{p.handicapIndex ? ` (${t("handicapIndexShort")}: ${p.handicapIndex})` : ""}
                    </Text>
                  ))}
                </View>
              </TouchableOpacity>
            )}
            ListEmptyComponent={<View style={styles.emptyState}><Feather name="users" size={32} color={Colors.muted} /><Text style={styles.emptyText}>{t("noGroupsForRound")}</Text></View>}
          />
        )}
      </SafeAreaView>
    );
  }

  if (screen === "scoring" && selectedGroup) {
    const totalHoles = 18;
    const scoredHoles = new Set(selectedGroup.scores.map(s => s.holeNumber));

    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => setScreen("group-list")} style={{ padding: 4 }}>
            <Feather name="chevron-left" size={24} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>{t("holeTitle", { hole: currentHole })}</Text>
          <TouchableOpacity
            style={styles.submitSmallBtn}
            onPress={() => Alert.alert(t("submitScorecard"), t("submitNow"), [
              { text: t("cancel"), style: "cancel" },
              { text: t("submit"), onPress: submitScorecard },
            ])}
          >
            <Text style={styles.submitSmallBtnText}>{t("submit")}</Text>
          </TouchableOpacity>
        </View>

        {/* Hole info */}
        <View style={styles.holeInfo}>
          <View style={styles.holeInfoLeft}>
            <Text style={styles.holeLabelText}>{t("holeUpperLabel")}</Text>
            <Text style={styles.holeNum}>{currentHole}</Text>
          </View>
          <View style={styles.holeInfoRight}>
            {currentCH && <Text style={styles.holeParText}>{t("parWithValue", { par: currentCH.par })}</Text>}
            {selectedTournament?.format === 'maximum_score' && currentCH && selectedTournament.maxScoreCap != null && (
              <Text style={[styles.holeSIText, { color: "#f59e0b" }]}>{t("maxWithValue", { max: currentCH.par + selectedTournament.maxScoreCap })}</Text>
            )}
            {selectedTournament?.format === 'par_bogey' && (
              <Text style={[styles.holeSIText, { color: Colors.primary }]}>{t("winLossInitials")}</Text>
            )}
            {currentCH?.handicap && <Text style={styles.holeSIText}>{t("siWithValue", { si: currentCH.handicap })}</Text>}
            {currentCH?.distance && <Text style={styles.holeDistText}>{t("metersShort", { distance: currentCH.distance })}</Text>}
          </View>
        </View>

        {/* Local Rules banner */}
        {hasLocalRules && (
          <View style={styles.localRulesBanner}>
            <TouchableOpacity
              style={styles.localRulesBannerHeader}
              onPress={() => setLocalRulesBannerOpen(o => !o)}
            >
              <Feather name="info" size={13} color={GOLD} />
              <Text style={styles.localRulesTitle}>{t("localRulesInEffect")}</Text>
              <Feather name={localRulesBannerOpen ? "chevron-up" : "chevron-down"} size={13} color={GOLD} />
            </TouchableOpacity>
            {localRulesBannerOpen && (
              <View style={styles.localRulesBody}>
                {activeLocalRuleFlags.map((flag, i) => (
                  <View key={i} style={{ flexDirection: "row", gap: 6, marginBottom: 2 }}>
                    <Text style={{ color: GOLD, fontSize: 11 }}>•</Text>
                    <Text style={styles.localRuleItem}>{flag}</Text>
                  </View>
                ))}
                {localRules ? <Text style={styles.localRuleText}>{localRules}</Text> : null}
              </View>
            )}
          </View>
        )}

        {/* Hole progress dots */}
        <View style={styles.dotRow}>
          {Array.from({ length: totalHoles }, (_, i) => i + 1).map(h => (
            <TouchableOpacity key={h} onPress={() => {
              setCurrentHole(h);
              const ch = courseHoles.find(c => c.holeNumber === h);
              const newScores: Record<number, number> = {};
              selectedGroup.players.forEach(p => {
                const ex = selectedGroup.scores.find(s => s.playerId === p.playerId && s.holeNumber === h);
                newScores[p.playerId] = ex?.strokes ?? ch?.par ?? 4;
              });
              setPendingScores(newScores);
            }} style={[styles.dot, h === currentHole && styles.dotActive, scoredHoles.has(h) && styles.dotScored]}>
              <Text style={[styles.dotText, h === currentHole && { color: "#000" }]}>{h}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Player scores */}
        <ScrollView style={styles.scroll}>
          {selectedGroup.players.map(player => {
            const sc = pendingScores[player.playerId] ?? currentCH?.par ?? 4;
            const par = currentCH?.par ?? 4;
            const toPar = sc - par;
            const isMaxScore = selectedTournament?.format === 'maximum_score';
            const isParBogey = selectedTournament?.format === 'par_bogey';
            const cap = selectedTournament?.maxScoreCap ?? null;
            const capped = isMaxScore && cap !== null && sc > par + cap;
            // Running par/bogey W/L from existing scores for this player
            const pbRunning = isParBogey ? (() => {
              let w = 0, l = 0, h = 0;
              selectedGroup.scores.filter(s => s.playerId === player.playerId && s.holeNumber < currentHole).forEach(s => {
                const hp = courseHoles.find(c => c.holeNumber === s.holeNumber)?.par ?? 4;
                if (s.strokes < hp) w++; else if (s.strokes > hp) l++; else h++;
              });
              return { w, l, h };
            })() : null;
            return (
              <View key={player.playerId} style={styles.playerScoreCard}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={styles.playerScoreName}>{player.name}</Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    {isParBogey && pbRunning !== null && (
                      <Text style={{ fontSize: 12, color: Colors.textSecondary }}>{t("parBogeyRunning", { w: pbRunning.w, l: pbRunning.l, h: pbRunning.h })}</Text>
                    )}
                    {capped && (
                      <Text style={{ fontSize: 12, color: "#f59e0b" }}>{t("cappedTo", { value: par + cap! })}</Text>
                    )}
                    <TouchableOpacity
                      style={styles.logShotBtn}
                      onPress={() => openShotModal({ playerId: player.playerId, name: player.name })}
                    >
                      <Feather name="target" size={12} color={GOLD} />
                      <Text style={styles.logShotBtnText}>{t("logShot")}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
                <View style={styles.playerScoreControls}>
                  <TouchableOpacity
                    style={styles.scorerBtn}
                    onPress={() => changeScore(player.playerId, -1)}
                    disabled={sc <= 1}
                  >
                    <Feather name="minus" size={24} color={sc <= 1 ? Colors.muted : Colors.text} />
                  </TouchableOpacity>
                  <View style={styles.scorerValueWrap}>
                    <Text style={styles.scorerValue}>{sc}</Text>
                    <Text style={[styles.scorerToPar, { color: toPar < 0 ? "#f87171" : toPar === 0 ? Colors.muted : "#60a5fa" }]}>
                      {isParBogey
                        ? (toPar < 0 ? t("winShort") : toPar === 0 ? t("halfShort") : t("lossShort"))
                        : (toPar === 0 ? t("parShort") : toPar === -1 ? t("birdie") : toPar === -2 ? t("eagle") : toPar > 0 ? `+${toPar}` : `${toPar}`)}
                    </Text>
                  </View>
                  <TouchableOpacity
                    style={styles.scorerBtn}
                    onPress={() => changeScore(player.playerId, 1)}
                    disabled={sc >= 15}
                  >
                    <Feather name="plus" size={24} color={sc >= 15 ? Colors.muted : Colors.text} />
                  </TouchableOpacity>
                </View>
                {/* Shots logged so far for this player on the current hole */}
                {(() => {
                  const playerShots = selectedGroup.shots
                    .filter(s => s.playerId === player.playerId && s.holeNumber === currentHole)
                    .sort((a, b) => a.shotNumber - b.shotNumber);
                  if (playerShots.length === 0) {
                    return (
                      <Text style={styles.shotsEmpty}>{t("noShotsLoggedYet", { hole: currentHole })}</Text>
                    );
                  }
                  return (
                    <View style={styles.shotsList}>
                      <Text style={styles.shotsHeader}>{t("shotsLoggedHeader", { hole: currentHole })}</Text>
                      {playerShots.map(s => {
                        const hasGps = s.latitude != null && s.longitude != null;
                        return (
                          <View key={s.id} style={styles.shotRow}>
                            <TouchableOpacity
                              style={styles.shotRowMain}
                              onPress={() => openEditShotModal({ playerId: player.playerId, name: player.name }, s)}
                            >
                              <Text style={styles.shotRowNum}>#{s.shotNumber}</Text>
                              <Text style={styles.shotRowType}>{t(`chipShotType.${s.shotType}`)}</Text>
                              <Text style={styles.shotRowMeta} numberOfLines={1}>
                                {s.club ?? "—"} · {translateLieType(tProfile, s.lieType)}
                              </Text>
                              {hasGps && <Feather name="map-pin" size={11} color={GOLD} />}
                              <Feather name="edit-2" size={11} color={Colors.muted} />
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={styles.shotRowDeleteBtn}
                              onPress={() => confirmDeleteShot({ playerId: player.playerId, name: player.name }, s)}
                              accessibilityLabel={t("deleteShotA11y", { shot: s.shotNumber, hole: s.holeNumber })}
                              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                            >
                              <Feather name="trash-2" size={13} color="#f87171" />
                            </TouchableOpacity>
                          </View>
                        );
                      })}
                    </View>
                  );
                })()}
              </View>
            );
          })}
        </ScrollView>

        {/* Log shot modal */}
        <Modal visible={!!shotModalPlayer} transparent animationType="slide" onRequestClose={() => setShotModalPlayer(null)}>
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>{editingShotId != null ? t("editShot") : t("logShot")} · {shotModalPlayer?.name}</Text>
                <TouchableOpacity onPress={() => setShotModalPlayer(null)}>
                  <Feather name="x" size={20} color={Colors.text} />
                </TouchableOpacity>
              </View>
              <ScrollView style={{ maxHeight: 460 }}>
                <Text style={styles.modalLabel}>{t("modalLabelHole")}</Text>
                <View style={styles.chipRow}>
                  <TouchableOpacity style={styles.stepBtn} onPress={() => setShotHole(h => Math.max(1, h - 1))}>
                    <Feather name="minus" size={16} color={Colors.text} />
                  </TouchableOpacity>
                  <Text style={styles.stepValue}>{shotHole}</Text>
                  <TouchableOpacity style={styles.stepBtn} onPress={() => setShotHole(h => Math.min(18, h + 1))}>
                    <Feather name="plus" size={16} color={Colors.text} />
                  </TouchableOpacity>
                </View>

                <Text style={styles.modalLabel}>{t("modalLabelShotNumber")}</Text>
                <View style={styles.chipRow}>
                  <TouchableOpacity style={styles.stepBtn} onPress={() => setShotNumber(n => Math.max(1, n - 1))}>
                    <Feather name="minus" size={16} color={Colors.text} />
                  </TouchableOpacity>
                  <Text style={styles.stepValue}>{shotNumber}</Text>
                  <TouchableOpacity style={styles.stepBtn} onPress={() => setShotNumber(n => Math.min(20, n + 1))}>
                    <Feather name="plus" size={16} color={Colors.text} />
                  </TouchableOpacity>
                </View>

                <Text style={styles.modalLabel}>{t("modalLabelType")}</Text>
                <View style={styles.chipWrap}>
                  {SHOT_TYPES.map(st => (
                    <TouchableOpacity key={st} onPress={() => setShotType(st)} style={[styles.chip, shotType === st && styles.chipActive]}>
                      <Text style={[styles.chipText, shotType === st && styles.chipTextActive]}>{t(`chipShotType.${st}`)}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.modalLabel}>{t("modalLabelClub")}</Text>
                <View style={styles.chipWrap}>
                  {CLUBS.map(c => (
                    <TouchableOpacity key={c} onPress={() => setShotClub(shotClub === c ? null : c)} style={[styles.chip, shotClub === c && styles.chipActive]}>
                      <Text style={[styles.chipText, shotClub === c && styles.chipTextActive]}>{c}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.modalLabel}>{t("modalLabelLie")}</Text>
                <View style={styles.chipWrap}>
                  {LIE_TYPES.map(l => (
                    <TouchableOpacity key={l} onPress={() => setShotLie(shotLie === l ? null : l)} style={[styles.chip, shotLie === l && styles.chipActive]}>
                      <Text style={[styles.chipText, shotLie === l && styles.chipTextActive]}>{t(`chipLie.${l}`)}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={styles.modalLabel}>{t("modalLabelGps")}</Text>
                <View style={styles.gpsRow}>
                  <TouchableOpacity style={[styles.gpsBtn, { flex: 1 }]} onPress={captureShotGps} disabled={shotGpsLoading}>
                    <Feather name="map-pin" size={14} color={GOLD} />
                    <Text style={styles.gpsBtnText}>
                      {shotGpsLoading ? t("gpsLocating") :
                        shotCoords ? `${shotCoords.lat.toFixed(5)}, ${shotCoords.lng.toFixed(5)}` : t("gpsCapture")}
                    </Text>
                  </TouchableOpacity>
                  {shotCoords && (
                    <TouchableOpacity onPress={() => setShotCoords(null)} style={styles.gpsClearBtn}>
                      <Feather name="x" size={16} color={Colors.muted} />
                    </TouchableOpacity>
                  )}
                </View>
              </ScrollView>

              <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
                <TouchableOpacity style={[styles.modalBtn, styles.modalBtnGhost]} onPress={() => setShotModalPlayer(null)}>
                  <Text style={styles.modalBtnGhostText}>{t("cancel")}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalBtn, styles.modalBtnPrimary, shotSubmitting && { opacity: 0.6 }]}
                  onPress={submitShot}
                  disabled={shotSubmitting}
                >
                  <Text style={styles.modalBtnPrimaryText}>{shotSubmitting ? t("savingEllipsis") : t("saveShot")}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>

        {/* Save & advance */}
        <View style={styles.bottomAction}>
          <TouchableOpacity
            style={[styles.saveHoleBtn, submitting && { opacity: 0.6 }]}
            onPress={saveHoleAndAdvance}
            disabled={submitting}
          >
            <Text style={styles.saveHoleBtnText}>
              {submitting ? t("savingDots") : currentHole < 18 ? t("saveHoleAndNext", { hole: currentHole }) : t("completeRound")}
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return <SafeAreaView style={styles.container}><LoadingSpinner color={GOLD} style={{ marginTop: 80 }} /></SafeAreaView>;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  title: { flex: 1, fontSize: 18, fontWeight: "700", color: Colors.text },
  sectionLabel: { fontSize: 13, color: Colors.muted, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5, marginHorizontal: 16, marginBottom: 8 },
  scroll: { flex: 1 },
  card: { backgroundColor: Colors.surface, borderRadius: 12, padding: 16, marginBottom: 10, marginHorizontal: 16, borderWidth: 1, borderColor: Colors.border },
  cardTitle: { color: Colors.text, fontSize: 16, fontWeight: "700" },
  activeBadge: { marginTop: 6, alignSelf: "flex-start", backgroundColor: "#22c55e20", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: "#22c55e40" },
  activeBadgeText: { color: "#22c55e", fontSize: 11, fontWeight: "600" },
  groupHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  startHole: { color: Colors.muted, fontSize: 12 },
  playerList: { gap: 4 },
  playerName: { color: Colors.text, fontSize: 14 },
  emptyState: { alignItems: "center", padding: 40 },
  emptyText: { color: Colors.muted, fontSize: 15, marginTop: 12 },
  holeInfo: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginHorizontal: 16, marginVertical: 8, backgroundColor: Colors.surface, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: `${GOLD}30` },
  holeInfoLeft: { alignItems: "center" },
  holeLabelText: { color: Colors.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1 },
  holeNum: { color: GOLD, fontSize: 48, fontWeight: "800", lineHeight: 54 },
  holeInfoRight: { alignItems: "flex-end", gap: 2 },
  holeParText: { color: Colors.text, fontSize: 18, fontWeight: "700" },
  holeSIText: { color: Colors.muted, fontSize: 14 },
  holeDistText: { color: Colors.muted, fontSize: 13 },
  dotRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "center", paddingHorizontal: 16, marginBottom: 8 },
  dot: { width: 28, height: 28, borderRadius: 14, backgroundColor: "#ffffff10", alignItems: "center", justifyContent: "center" },
  dotActive: { backgroundColor: GOLD },
  dotScored: { backgroundColor: "#22c55e30", borderWidth: 1, borderColor: "#22c55e50" },
  dotText: { color: Colors.muted, fontSize: 10, fontWeight: "600" },
  playerScoreCard: { backgroundColor: Colors.surface, marginHorizontal: 16, borderRadius: 12, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: Colors.border },
  playerScoreName: { color: Colors.text, fontSize: 15, fontWeight: "600", marginBottom: 12 },
  playerScoreControls: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  scorerBtn: { width: 56, height: 56, borderRadius: 28, borderWidth: 2, borderColor: Colors.border, alignItems: "center", justifyContent: "center" },
  scorerValueWrap: { alignItems: "center" },
  scorerValue: { color: Colors.text, fontSize: 40, fontWeight: "800" },
  scorerToPar: { fontSize: 13, fontWeight: "600" },
  bottomAction: { padding: 16, paddingBottom: 24 },
  saveHoleBtn: { backgroundColor: GOLD, borderRadius: 14, paddingVertical: 16, alignItems: "center" },
  saveHoleBtnText: { color: "#000", fontSize: 16, fontWeight: "700" },
  submitSmallBtn: { backgroundColor: "#22c55e30", borderWidth: 1, borderColor: "#22c55e50", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  submitSmallBtnText: { color: "#22c55e", fontSize: 13, fontWeight: "600" },
  localRulesBanner: { marginHorizontal: 16, marginBottom: 8, borderRadius: 10, borderWidth: 1, borderColor: `${GOLD}30`, backgroundColor: `${GOLD}10`, overflow: "hidden" },
  localRulesBannerHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  localRulesTitle: { flex: 1, color: GOLD, fontSize: 12, fontWeight: "600" },
  localRulesBody: { paddingHorizontal: 12, paddingBottom: 10 },
  localRuleItem: { color: "rgba(255,255,255,0.8)", fontSize: 11, flex: 1 },
  localRuleText: { color: "rgba(255,255,255,0.65)", fontSize: 11, lineHeight: 16, marginTop: 4 },
  logShotBtn: { flexDirection: "row", alignItems: "center", gap: 4, borderWidth: 1, borderColor: `${GOLD}60`, backgroundColor: `${GOLD}18`, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  logShotBtnText: { color: GOLD, fontSize: 11, fontWeight: "600" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  modalCard: { backgroundColor: Colors.surface, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, borderWidth: 1, borderColor: Colors.border },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  modalTitle: { color: Colors.text, fontSize: 16, fontWeight: "700" },
  modalLabel: { color: Colors.muted, fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 12, marginBottom: 6 },
  chipRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: Colors.border, backgroundColor: "#ffffff08" },
  chipActive: { backgroundColor: GOLD, borderColor: GOLD },
  chipText: { color: Colors.text, fontSize: 12, fontWeight: "600" },
  chipTextActive: { color: "#000" },
  stepBtn: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: Colors.border, alignItems: "center", justifyContent: "center" },
  stepValue: { color: Colors.text, fontSize: 18, fontWeight: "700", minWidth: 32, textAlign: "center" },
  gpsRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  gpsBtn: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: `${GOLD}40`, backgroundColor: `${GOLD}14`, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  gpsBtnText: { color: Colors.text, fontSize: 13 },
  gpsClearBtn: { width: 40, height: 40, borderRadius: 10, borderWidth: 1, borderColor: Colors.border, alignItems: "center", justifyContent: "center" },
  modalBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: "center" },
  modalBtnGhost: { borderWidth: 1, borderColor: Colors.border },
  modalBtnGhostText: { color: Colors.text, fontSize: 14, fontWeight: "600" },
  modalBtnPrimary: { backgroundColor: GOLD },
  modalBtnPrimaryText: { color: "#000", fontSize: 14, fontWeight: "700" },
  shotsEmpty: { color: Colors.muted, fontSize: 11, marginTop: 12, fontStyle: "italic" },
  shotsList: { marginTop: 12, gap: 4, borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 8 },
  shotsHeader: { color: Colors.muted, fontSize: 10, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 },
  shotRow: { flexDirection: "row", alignItems: "center", borderRadius: 8, backgroundColor: "#ffffff06" },
  shotRowMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, paddingLeft: 8, paddingRight: 4 },
  shotRowDeleteBtn: { paddingVertical: 6, paddingHorizontal: 10, alignItems: "center", justifyContent: "center" },
  shotRowNum: { color: GOLD, fontSize: 12, fontWeight: "700", minWidth: 24 },
  shotRowType: { color: Colors.text, fontSize: 12, fontWeight: "600", minWidth: 60, textTransform: "capitalize" },
  shotRowMeta: { flex: 1, color: Colors.muted, fontSize: 11 },
});
