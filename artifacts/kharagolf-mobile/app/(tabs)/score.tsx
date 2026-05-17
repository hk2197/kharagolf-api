import { Feather, Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery } from "@tanstack/react-query";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Accelerometer } from "expo-sensors";
import * as Haptics from "expo-haptics";
import { useRouter, useFocusEffect } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Animated,
  AppState,
  FlatList,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { captureRef } from "react-native-view-shot";
import * as Sharing from "expo-sharing";
import * as Calendar from "expo-calendar";
import * as FileSystem from "expo-file-system";
import Colors from "@/constants/colors";
import QRCheckInScanner from "@/components/QRCheckInScanner";
import { fetchPublic, postPublic, fetchPortal, postPortal, patchPortal, deletePortal, BASE_URL, ConsentRequiredError } from "@/utils/api";
import { type ServerShot } from "@/components/ShotReviewModal";
import HoleShotReviewModal from "@/components/HoleShotReviewModal";
import RoundSummaryHoleDots from "@/components/RoundSummaryHoleDots";
import { syncAppleHealthLast7Days, isAppleHealthSupported } from "@/utils/appleHealth";
import { syncHealthConnectLast7Days, isHealthConnectSupported } from "@/utils/healthConnect";
import { useAuth } from "@/context/auth";
import MemberAvatar from "@/components/MemberAvatar";
import RoundSummaryCard from "@/components/RoundSummaryCard";
import { SideGamesPanel } from "@/components/SideGamesPanel";
import { getLocale } from "@/i18n";
import HoleMapSheet, { playsLikeBreakdown, type PlaysLikeBreakdown } from "@/components/HoleMapSheet";
import GpsDistanceRow from "@/components/GpsDistanceRow";
import CaddieCard, { type AimPoint } from "@/components/CaddieCard";
import { prefetchSnapshot, flushFeedbackQueue } from "@/utils/caddieOffline";
import { prefetchCourseBundle } from "@/utils/courseBundle";
import {
  useHolesWithCachedFallback,
  type HolesResponse,
  type HoleInfo,
} from "@/utils/useHolesWithCachedFallback";
import { interpolatePinElevation } from "@/utils/pinElevation";
import { buildAcceptedShotsPayload } from "@/utils/autoShotPayload";
import { AutoHoleHrStrip } from "@/components/HrStrip";
import InlineAdBanner from "@/components/InlineAdBanner";
import {
  OFFLINE_QUEUE_KEY,
  type OfflineScore,
  type BatchConflict,
  type FlushResult,
  mergeBatchConflicts,
  enqueueScore,
  flushOfflineQueue,
} from "@/utils/offlineScoreQueue";

const SESSION_KEY = "kharagolf_scoring_session";
const OFFLINE_SHOTS_KEY = "kharagolf_offline_shot_queue";
const AUTO_DETECT_SENSITIVITY_KEY = "kharagolf_auto_shot_sensitivity";

// Background location task — registered at module scope so the OS can wake
// the app and resume sample collection even when the player has the screen
// off mid-round. Samples land in AsyncStorage so the foreground component
// can hand them to the auto-detect engine when the round ends.
const BACKGROUND_LOCATION_TASK = "kharagolf-background-location";
const BACKGROUND_GPS_BUFFER_KEY = "kharagolf_background_gps_buffer";

if (!TaskManager.isTaskDefined(BACKGROUND_LOCATION_TASK)) {
  TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }: { data: { locations?: Array<{ coords: { latitude: number; longitude: number; accuracy?: number | null }; timestamp: number }> } | undefined; error: unknown }) => {
    if (error || !data?.locations?.length) return;
    try {
      const raw = await AsyncStorage.getItem(BACKGROUND_GPS_BUFFER_KEY);
      const existing: Array<{ lat: number; lng: number; timestamp: number; accuracy?: number | null }> =
        raw ? JSON.parse(raw) : [];
      for (const loc of data.locations) {
        existing.push({
          lat: loc.coords.latitude,
          lng: loc.coords.longitude,
          timestamp: loc.timestamp ?? Date.now(),
          accuracy: loc.coords.accuracy ?? null,
        });
      }
      // Cap stored samples (~6h at 5s = ~4320) so AsyncStorage stays bounded.
      const trimmed = existing.length > 6000 ? existing.slice(-6000) : existing;
      await AsyncStorage.setItem(BACKGROUND_GPS_BUFFER_KEY, JSON.stringify(trimmed));
    } catch {/* swallow — next sample will retry */}
  });
}

type AutoShotSensitivity = "low" | "medium" | "high";

interface DetectedShotProposal {
  holeNumber: number;
  shotNumber: number;
  shotType: string;
  club?: string | null;
  latitude: number;
  longitude: number;
  distanceToPinYards: number;
  recordedAt: string;
  source: string;
  confidence: number;
}

// ── Haversine GPS distance ──────────────────────────────────────────
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLng = (lng2 - lng1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function metersToYards(m: number) { return Math.round(m * 1.09361); }

// Bearing from point 1 to point 2 in degrees (0=N, 90=E)
function bearingDegrees(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const la1 = lat1 * Math.PI / 180;
  const la2 = lat2 * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// ── Weather types ───────────────────────────────────────────────────
interface WeatherData {
  temperature: number;
  windSpeed: number;
  windDirection: number;
  precipitation: number;
  weatherCode: number;
  description?: string;
  humidity?: number;
  feelsLike?: number;
  alerts?: string[];
}

function weatherCodeToIcon(code: number): string {
  if (code === 0) return "☀️";
  if (code <= 2) return "⛅";
  if (code <= 48) return "🌫️";
  if (code <= 67) return "🌧️";
  if (code <= 77) return "🌨️";
  if (code <= 82) return "🌦️";
  return "⛈️";
}

function windDegToCompass(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

// ── Shot types ──────────────────────────────────────────────────────
const SHOT_TYPES = [
  { key: "tee", label: "Tee" },
  { key: "fairway", label: "Fairway" },
  { key: "approach", label: "Approach" },
  { key: "chip", label: "Chip" },
  { key: "sand", label: "Sand" },
  { key: "putt", label: "Putt" },
] as const;
type ShotType = typeof SHOT_TYPES[number]["key"];

// Standard clubs (ordered from longest to shortest)
const STANDARD_CLUBS = [
  "Dr", "3W", "5W", "7W",
  "2H", "3H", "4H", "5H",
  "3I", "4I", "5I", "6I", "7I", "8I", "9I",
  "PW", "GW", "SW", "LW",
  "Putter",
];

const MISS_DIRECTIONS = ["Left", "Right", "Short", "Long", "On Target"] as const;
type MissDirection = typeof MISS_DIRECTIONS[number];

const LIE_TYPES = ["Tee", "Fairway", "Rough", "Bunker", "Hazard", "Green"] as const;
type LieType = typeof LIE_TYPES[number];

const SHOT_SHAPES = ["Draw", "Straight", "Fade"] as const;
type ShotShape = typeof SHOT_SHAPES[number];

const PENALTY_REASONS = ["OB", "Water", "Unplayable", "Other"] as const;
type PenaltyReason = typeof PENALTY_REASONS[number];

interface ShotRecord {
  tournamentId?: number | null;
  generalPlayRoundId?: number | null;
  playerId?: number | null;
  userId?: number | null;
  round: number;
  holeNumber: number;
  shotNumber: number;
  shotType: ShotType;
  club?: string | null;
  missDirection?: string | null;
  lieType?: string | null;
  shotShape?: string | null;
  penaltyReason?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  distanceToPin?: number | null;
  recordedAt: string;
}

// ── Offline shot persistence ─────────────────────────────────────────
async function enqueueShot(shot: ShotRecord) {
  const raw = await AsyncStorage.getItem(OFFLINE_SHOTS_KEY);
  const queue: ShotRecord[] = raw ? JSON.parse(raw) : [];
  queue.push(shot);
  await AsyncStorage.setItem(OFFLINE_SHOTS_KEY, JSON.stringify(queue));
}

async function loadPersistedShots(tournamentId: number, playerId: number): Promise<ShotRecord[]> {
  const raw = await AsyncStorage.getItem(OFFLINE_SHOTS_KEY);
  if (!raw) return [];
  const all: ShotRecord[] = JSON.parse(raw);
  return all.filter(s => s.tournamentId === tournamentId && s.playerId === playerId);
}

async function clearPersistedShots(tournamentId: number, playerId: number) {
  const raw = await AsyncStorage.getItem(OFFLINE_SHOTS_KEY);
  if (!raw) return;
  const all: ShotRecord[] = JSON.parse(raw);
  const remaining = all.filter(s => !(s.tournamentId === tournamentId && s.playerId === playerId));
  await AsyncStorage.setItem(OFFLINE_SHOTS_KEY, JSON.stringify(remaining));
}

interface SGHoleBreakdown {
  holeNumber: number;
  sgPutting: number;
  sgApproach: number;
  sgATG: number;
  sgOTT: number;
  sgTotal: number;
  puttingEstimated?: boolean;
}

interface SGRoundResponse {
  baseline: string;
  round: number;
  shotsTracked: number;
  holes: SGHoleBreakdown[];
  totals: { sgPutting: number; sgApproach: number; sgATG: number; sgOTT: number; sgTotal: number; puttingEstimated?: boolean } | null;
}

interface Tournament {
  id: number;
  name: string;
  format: string;
  status: string;
  organizationId: number;
  organizationName: string;
  organizationPrimaryColor?: string | null;
  courseName?: string;
  startDate?: string | null;
  endDate?: string | null;
  selfPosting?: boolean;
  markerValidation?: boolean;
}

interface Player {
  id: number;
  firstName: string;
  lastName: string;
  handicapIndex: number | null;
  flight: string | null;
  teeBox: string;
  profileImage?: string | null;
}

// HoleInfo + HolesResponse live in `@/utils/useHolesWithCachedFallback` so
// the offline-fallback hook + score-screen consumer share a single
// canonical type. Imported above as `import type { HoleInfo, HolesResponse }`.

interface Session {
  tournamentId: number;
  tournamentName: string;
  playerId: number;
  playerName: string;
  round: number;
  organizationId?: number;
  orgName?: string;
  orgColor?: string | null;
  handicapIndex?: number | null;
  markerPlayerId?: number | null;
  markerName?: string | null;
}

interface MarkerCandidate {
  playerId: number;
  userId: number | null;
  name: string;
  email: string | null;
  previousPlayCount: number;
}

type Step = "tournament" | "player" | "marker" | "scoring";

function getScoreLabel(strokes: number, par: number): { label: string; color: string } {
  const diff = strokes - par;
  if (strokes === 1) return { label: "HOLE IN ONE!", color: Colors.eagle };
  if (diff <= -2) return { label: "EAGLE", color: Colors.eagle };
  if (diff === -1) return { label: "BIRDIE", color: Colors.birdie };
  if (diff === 0) return { label: "PAR", color: Colors.par };
  if (diff === 1) return { label: "BOGEY", color: Colors.bogey };
  if (diff === 2) return { label: "DOUBLE", color: Colors.doubleOrWorse };
  return { label: "+3 OR MORE", color: Colors.doubleOrWorse };
}

// ── ICS fallback: download and share via expo-sharing ─────────────────
async function shareIcsFile(t: Tournament) {
  try {
    const icsUrl = `${BASE_URL}/api/public/tournaments/${t.id}/calendar.ics`;
    const downloadRes = await fetch(icsUrl);
    if (!downloadRes.ok) throw new Error("Failed to download calendar file");
    const icsText = await downloadRes.text();
    const fileUri = `${FileSystem.cacheDirectory}tournament-${t.id}.ics`;
    await FileSystem.writeAsStringAsync(fileUri, icsText, { encoding: FileSystem.EncodingType.UTF8 });
    const canShare = await Sharing.isAvailableAsync();
    if (!canShare) {
      Alert.alert("Sharing Unavailable", "Sharing is not available on this device.");
      return;
    }
    await Sharing.shareAsync(fileUri, { mimeType: "text/calendar", dialogTitle: `Add ${t.name} to Calendar`, UTI: "public.calendar-event" });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    Alert.alert("Calendar Error", msg ?? "Could not share calendar file.");
  }
}

// ── Add to Calendar helper ───────────────────────────────────────────
async function addTournamentToCalendar(t: Tournament) {
  try {
    const { status } = await Calendar.requestCalendarPermissionsAsync();
    if (status !== "granted") {
      // Fallback: share .ics file instead
      await shareIcsFile(t);
      return;
    }
    const startDate = t.startDate ? new Date(t.startDate) : new Date();
    const endDate = t.endDate ? new Date(t.endDate) : new Date(startDate.getTime() + 8 * 60 * 60 * 1000);
    let calendarId: string | undefined;
    if (Platform.OS === "ios") {
      const defaultCal = await Calendar.getDefaultCalendarAsync();
      calendarId = defaultCal?.id;
    } else {
      const cals = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
      calendarId = cals.find(c => c.accessLevel === Calendar.CalendarAccessLevel.OWNER)?.id ?? cals[0]?.id;
    }
    if (!calendarId) {
      // Fallback: share .ics file when no writable calendar found
      await shareIcsFile(t);
      return;
    }
    await Calendar.createEventAsync(calendarId, {
      title: t.name,
      startDate,
      endDate,
      location: t.courseName ?? undefined,
      notes: `Format: ${t.format?.replace(/_/g, " ")}\nOrganised by ${t.organizationName}`,
      alarms: [{ relativeOffset: -60 }],
    });
    Alert.alert("Added!", `"${t.name}" has been added to your calendar.`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    Alert.alert("Calendar Error", msg ?? "Could not add event.");
  }
}

// ── Step 1: Tournament Selection ────────────────────────────────────

function TournamentSelector({ onSelect }: { onSelect: (t: Tournament) => void }) {
  const { data: tournaments, isLoading } = useQuery({
    queryKey: ["public-tournaments"],
    queryFn: () => fetchPublic<Tournament[]>("/tournaments"),
  });

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={Colors.primary} />
        <Text style={styles.loadingText}>Loading tournaments...</Text>
      </View>
    );
  }

  if (!tournaments?.length) {
    return (
      <View style={styles.centered}>
        <Feather name="calendar" size={48} color={Colors.muted} />
        <Text style={styles.emptyTitle}>No Active Tournaments</Text>
        <Text style={styles.emptySubtitle}>There are no live tournaments at the moment.</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <Text style={styles.stepLabel}>SELECT TOURNAMENT</Text>
      <FlatList
        data={tournaments}
        keyExtractor={(t) => String(t.id)}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => onSelect(item)}
            style={({ pressed }) => [styles.selectCard, { opacity: pressed ? 0.8 : 1 }]}
          >
            <View style={styles.selectCardLeft}>
              <Text style={styles.selectCardTitle}>{item.name}</Text>
              <Text style={styles.selectCardSub}>{item.organizationName}</Text>
              {item.courseName ? (
                <Text style={styles.selectCardSub}>{item.courseName}</Text>
              ) : null}
              {item.startDate ? (
                <Text style={styles.selectCardSub}>
                  {new Date(item.startDate).toLocaleDateString(getLocale(), { day: "numeric", month: "short", year: "numeric" })}
                </Text>
              ) : null}
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Pressable
                onPress={(e) => { e.stopPropagation?.(); addTournamentToCalendar(item); }}
                style={styles.calBtn}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Add ${item.name ?? 'tournament'} to calendar`}
              >
                <Feather name="calendar" size={15} color={Colors.primary} accessible={false} />
              </Pressable>
              <Feather name="chevron-right" size={20} color={Colors.muted} />
            </View>
          </Pressable>
        )}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}

// ── QR Check-In Scanner ──────────────────────────────────────────────
// Extracted to `components/QRCheckInScanner.tsx` so vitest can render it
// without dragging score.tsx's expo-camera / expo-location / background-task
// imports into the test runner. See:
//   - components/QRCheckInScanner.tsx
//   - __tests__/qr-checkin-scanner-double-scan.test.tsx (Task #1362)

// ── Step 2: Player Selection ────────────────────────────────────────

function PlayerSelector({
  tournamentId,
  onSelect,
  onBack,
}: {
  tournamentId: number;
  onSelect: (p: Player) => void;
  onBack: () => void;
}) {
  const [search, setSearch] = useState("");
  const { data: players, isLoading } = useQuery({
    queryKey: ["players", tournamentId],
    queryFn: () => fetchPublic<Player[]>(`/tournaments/${tournamentId}/players`),
  });
  const { data: holesSetup } = useQuery({
    queryKey: ["holesSetup", tournamentId],
    queryFn: () => fetchPublic<HolesResponse>(`/tournaments/${tournamentId}/holes`),
  });
  const setupMissingPar = (holesSetup?.holes ?? []).some(h => !h.par || h.par === 0);

  const filtered = players?.filter((p) => {
    const full = `${p.firstName} ${p.lastName}`.toLowerCase();
    return full.includes(search.toLowerCase());
  });

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.stepHeader}>
        <Pressable onPress={onBack} style={styles.backBtn}>
          <Feather name="arrow-left" size={20} color={Colors.text} />
        </Pressable>
        <Text style={styles.stepLabel}>FIND YOUR NAME</Text>
      </View>

      {/* Missing-par setup warning: shown before scoring starts */}
      {setupMissingPar && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#fef3c7", paddingVertical: 10, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: "#f59e0b" }}>
          <Feather name="alert-triangle" size={14} color="#92400e" />
          <Text style={{ flex: 1, fontSize: 12, color: "#92400e", fontFamily: "Inter_600SemiBold" }}>
            This tournament has holes with missing par data. Contact your tournament director.
          </Text>
        </View>
      )}

      <View style={styles.searchBar}>
        <Feather name="search" size={16} color={Colors.muted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search by name..."
          placeholderTextColor={Colors.muted}
          value={search}
          onChangeText={setSearch}
          autoFocus
        />
        {search.length > 0 && (
          <Pressable onPress={() => setSearch("")}>
            <Feather name="x" size={16} color={Colors.muted} />
          </Pressable>
        )}
      </View>

      {isLoading ? (
        <View style={styles.centered}>
          <LoadingSpinner size="small" color={Colors.primary} />
        </View>
      ) : !filtered?.length ? (
        <View style={styles.centered}>
          <Feather name="user-x" size={40} color={Colors.muted} />
          <Text style={styles.emptyTitle}>
            {search ? "No players found" : "No players in this tournament"}
          </Text>
          {!search && (
            <Text style={styles.emptySubtitle}>
              Contact the tournament director to be added to the player list.
            </Text>
          )}
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(p) => String(p.id)}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => onSelect(item)}
              style={({ pressed }) => [styles.playerRow, { opacity: pressed ? 0.8 : 1 }]}
            >
              <MemberAvatar
                profileImage={item.profileImage}
                firstName={item.firstName}
                lastName={item.lastName}
                size={40}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.playerRowName}>
                  {item.firstName} {item.lastName}
                </Text>
                <Text style={styles.playerRowSub}>
                  HCP {item.handicapIndex ?? "N/A"} · {item.flight ?? "No flight"} · {item.teeBox}
                </Text>
              </View>
              <Feather name="chevron-right" size={18} color={Colors.muted} />
            </Pressable>
          )}
          contentContainerStyle={{ padding: 12, gap: 6 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        />
      )}
    </View>
  );
}

// ── Step 3: Score Entry ─────────────────────────────────────────────

type ClubProfileEntry = { club: string | null; avgDistance: number | null; minDistance: number | null; maxDistance: number | null; shotCount: number };

interface HoleCardProps {
  hole: HoleInfo;
  score: number | null;
  putts: number | null;
  onScoreChange: (score: number) => void;
  onPuttsChange: (putts: number) => void;
  isSaving: boolean;
  userLocation: Location.LocationObject | null;
  onLogShot: (shotType: ShotType, lat?: number, lng?: number, distToPin?: number, club?: string, missDirection?: string, lieType?: string, shotShape?: string, penaltyReason?: string) => void;
  shotCount: number;
  weather: WeatherData | null;
  clubProfile?: ClubProfileEntry[];
  courseHandicap?: number | null;
  onOpenMap?: () => void;
  pinLatOffset?: number;
  pinLngOffset?: number;
  // AI Caddie wiring (Task #356)
  token?: string | null;
  tournamentId?: number | null;
  generalPlayRoundId?: number | null;
  round?: number;
  // Task #1160 — passed through to CaddieCard so its offline fallback can
  // confirm a saved course bundle is available for this round.
  courseId?: number | null;
  // Task #1160 — true when hole data is sourced from the cached bundle.
  // Drives the small "saved course data" pill on GpsDistanceRow.
  usingCachedCourse?: boolean;
  onAimPointChange?: (aim: AimPoint | null) => void;
  onCaddieClubChosen?: (club: string, accepted: boolean) => void;
  sgForHole?: SGHoleBreakdown | null;
  onOpenReviewShots?: () => void;
}

const CLUB_SUGGESTION_MAX_DIFF_YARDS = 80;

function windCorrectDistance(targetYards: number, windSpeedMph: number, windFromDeg: number, hitTowardDeg: number): { effectiveDist: number; adj: number; headwindMph: number } {
  const windFrom = windFromDeg * (Math.PI / 180);
  const hitToward = hitTowardDeg * (Math.PI / 180);
  const headwindMph = windSpeedMph * Math.cos(windFrom - hitToward);
  const adj = headwindMph > 0 ? -(headwindMph * 1.0) : -(headwindMph * 0.6);
  return { effectiveDist: Math.round(targetYards - adj), adj: Math.round(adj), headwindMph: Math.round(headwindMph * 10) / 10 };
}

function findSuggestedClubs(profileEntries: ClubProfileEntry[], effectiveDist: number): { recommended: { club: string; avg: number } | null; alternate: { club: string; avg: number } | null } {
  const valid = profileEntries.filter(e => e.club && e.avgDistance !== null && e.avgDistance > 0).sort((a, b) => (b.avgDistance ?? 0) - (a.avgDistance ?? 0));
  if (valid.length === 0) return { recommended: null, alternate: null };
  let recommended: typeof valid[0] | null = null;
  let alternate: typeof valid[0] | null = null;
  for (const e of valid) {
    if ((e.avgDistance ?? 0) >= effectiveDist) {
      if (!recommended) recommended = e;
      else if (!alternate) { alternate = e; break; }
    }
  }
  if (!recommended && valid.length > 0) recommended = valid[0];
  if (recommended && !alternate) {
    const idx = valid.indexOf(recommended);
    if (idx > 0) alternate = valid[idx - 1];
  }
  if (recommended && Math.abs((recommended.avgDistance ?? 0) - effectiveDist) > CLUB_SUGGESTION_MAX_DIFF_YARDS) recommended = null;
  return { recommended: recommended ? { club: recommended.club!, avg: Math.round(recommended.avgDistance!) } : null, alternate: alternate ? { club: alternate.club!, avg: Math.round(alternate.avgDistance!) } : null };
}

function SGStat({ label, value, highlight, estimated }: { label: string; value: number; highlight?: boolean; estimated?: boolean }) {
  const sign = value > 0 ? "+" : "";
  const baseColor = value > 0.05 ? Colors.birdie : value < -0.05 ? Colors.bogey : Colors.textSecondary;
  // Muted style + "~" prefix when this figure is a scorecard-derived estimate
  // rather than measured from per-shot tracking. Tooltip-style hint via the
  // accessibility label keeps the on-screen footprint tiny.
  const color = estimated ? Colors.textSecondary : baseColor;
  return (
    <View style={styles.sgStatCell}>
      <Text style={styles.sgStatLabel}>
        {label}{estimated ? " ~" : ""}
      </Text>
      <Text
        style={[styles.sgStatValue, { color }, highlight && { fontSize: 16 }, estimated && { opacity: 0.65, fontStyle: "italic" }]}
        accessibilityLabel={estimated ? `${label} estimated from scorecard putts: ${sign}${value.toFixed(2)}` : undefined}
      >
        {estimated ? "~" : ""}{sign}{value.toFixed(2)}
      </Text>
    </View>
  );
}


function HoleCard({ hole, score, putts, onScoreChange, onPuttsChange, isSaving, userLocation, onLogShot, shotCount, weather, clubProfile, courseHandicap, onOpenMap, pinLatOffset = 0, pinLngOffset = 0, token, tournamentId, generalPlayRoundId, round, courseId, usingCachedCourse = false, onAimPointChange, onCaddieClubChosen, sgForHole, onOpenReviewShots }: HoleCardProps) {
  const hasPar = hole.par && hole.par > 0;
  const currentScore = score ?? (hasPar ? hole.par : 4);
  const diff = hasPar ? currentScore - hole.par : 0;
  const { label: scoreLabel, color: scoreColor } = getScoreLabel(currentScore, hasPar ? hole.par : 4);

  // Per-hole stroke allowance (WHS)
  const si = hole.handicap ?? 0;
  const ch = Math.round(courseHandicap ?? 0);
  const strokesReceived = si > 0 && ch > 0
    ? ch >= 18 + si ? 2 : ch >= si ? 1 : 0
    : 0;

  // Net Double Bogey cap
  const ndbCap = hasPar ? hole.par + 2 + strokesReceived : null;
  const isAtCap = ndbCap !== null && currentScore >= ndbCap;
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const [showShotPanel, setShowShotPanel] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [selectedShotType, setSelectedShotType] = useState<ShotType>("fairway");
  const [selectedClub, setSelectedClub] = useState<string | null>(null);
  const [selectedMissDir, setSelectedMissDir] = useState<string | null>(null);
  const [selectedLieType, setSelectedLieType] = useState<string | null>(null);
  const [selectedShotShape, setSelectedShotShape] = useState<string | null>(null);
  const [selectedPenaltyReason, setSelectedPenaltyReason] = useState<string | null>(null);

  // Reset per-shot selections when hole changes
  const prevHoleRef = useRef(hole.holeNumber);
  useEffect(() => {
    if (prevHoleRef.current !== hole.holeNumber) {
      prevHoleRef.current = hole.holeNumber;
      setSelectedClub(null);
      setSelectedMissDir(null);
      setSelectedLieType(null);
      setSelectedShotShape(null);
      setSelectedPenaltyReason(null);
    }
  }, [hole.holeNumber]);

  // GPS distances to green
  const centreLat = hole.greenCentreLat ? parseFloat(hole.greenCentreLat) : null;
  const centreLng = hole.greenCentreLng ? parseFloat(hole.greenCentreLng) : null;
  const frontLat = hole.greenFrontLat ? parseFloat(hole.greenFrontLat) : null;
  const frontLng = hole.greenFrontLng ? parseFloat(hole.greenFrontLng) : null;
  const backLat = hole.greenBackLat ? parseFloat(hole.greenBackLat) : null;
  const backLng = hole.greenBackLng ? parseFloat(hole.greenBackLng) : null;

  const userLat = userLocation?.coords.latitude ?? null;
  const userLng = userLocation?.coords.longitude ?? null;

  // Apply pin offset to green centre for more accurate distance-to-pin
  const pinLat = centreLat !== null ? centreLat + pinLatOffset : null;
  const pinLng = centreLng !== null ? centreLng + pinLngOffset : null;
  const hasPinOffset = Math.abs(pinLatOffset) > 0.000001 || Math.abs(pinLngOffset) > 0.000001;

  const distCentre = (userLat != null && userLng != null && pinLat != null && pinLng != null) ? haversineMeters(userLat, userLng, pinLat, pinLng) : null;
  const distFront = (userLat != null && userLng != null && frontLat != null && frontLng != null) ? haversineMeters(userLat, userLng, frontLat, frontLng) : null;
  const distBack = (userLat != null && userLng != null && backLat != null && backLng != null) ? haversineMeters(userLat, userLng, backLat, backLng) : null;

  // ── PlaysLike adjustments per F/C/B (Task #358) ─────────────────────────
  // bearingToTarget computed inline; uses wind + temperature from weather.
  // Elevation/altitude best-effort via Open-Meteo (1 fetch per hole load).
  const [pointElevations, setPointElevations] = useState<{ user: number; front: number; centre: number; back: number } | null>(null);
  useEffect(() => {
    if (userLat == null || userLng == null || centreLat == null || centreLng == null) { setPointElevations(null); return; }
    const lats = [userLat, frontLat ?? centreLat, centreLat, backLat ?? centreLat].join(",");
    const lngs = [userLng, frontLng ?? centreLng, centreLng, backLng ?? centreLng].join(",");
    fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`)
      .then(r => r.json())
      .then((d: { elevation?: number[] }) => {
        if (d.elevation && d.elevation.length === 4) {
          setPointElevations({ user: d.elevation[0], front: d.elevation[1], centre: d.elevation[2], back: d.elevation[3] });
        }
      })
      .catch(() => setPointElevations(null));
  }, [hole.holeNumber, userLat, userLng, centreLat, centreLng, frontLat, frontLng, backLat, backLng]);

  function plBearing(toLat: number, toLng: number): number {
    if (userLat == null || userLng == null) return 0;
    const dLng = (toLng - userLng) * Math.PI / 180;
    const la1 = userLat * Math.PI / 180, la2 = toLat * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(la2);
    const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
    return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
  }
  function computePL(distM: number | null, toLat: number | null, toLng: number | null, targetElev: number | undefined): PlaysLikeBreakdown | null {
    if (!distM || !toLat || !toLng || !weather) return null;
    const yds = metersToYards(distM);
    const elevDiff = (pointElevations && targetElev !== undefined) ? targetElev - pointElevations.user : undefined;
    return playsLikeBreakdown(yds, weather.windSpeed, weather.windDirection, plBearing(toLat, toLng), elevDiff, weather.temperature, pointElevations?.user);
  }
  // Interpolate elevation at the actual pin position (not just green centre)
  // by projecting the saved pin offset onto the green's front→back axis. This
  // matches the AI Caddie's "plays-like" elevation on sloped greens.
  const pinElevation = (pointElevations && pinLat != null && pinLng != null
      && frontLat != null && frontLng != null && centreLat != null && centreLng != null
      && backLat != null && backLng != null)
    ? interpolatePinElevation(
        pinLat, pinLng,
        frontLat, frontLng,
        centreLat, centreLng,
        backLat, backLng,
        { front: pointElevations.front, centre: pointElevations.centre, back: pointElevations.back },
      )
    : pointElevations?.centre;
  const plFront  = computePL(distFront,  frontLat,  frontLng,  pointElevations?.front);
  const plCentre = computePL(distCentre, pinLat,    pinLng,    pinElevation);
  const plBack   = computePL(distBack,   backLat,   backLng,   pointElevations?.back);

  // ── Hole-header plays-like (Task #562) ─────────────────────────────────
  // To guarantee parity with the watch widget / Wear OS Tile we *prefer* the
  // server-canonical value from `/portal/watch/hole-context`, which uses the
  // exact same wind + tee→green elevation contract as the watch. We fall back
  // to a local wind+elev computation only when the server lookup is
  // unavailable (general-play mode, no enrolment, network offline) AND the
  // player has a live GPS fix — otherwise we omit the line rather than
  // invent a bearing.
  const headerYards = hole.yardageWhite ?? null;

  // Server-canonical breakdown. We deliberately query *without* lat/lng so
  // the server uses the course-centre fallback — exactly what the WS watch
  // push does — guaranteeing the phone header shows the same number the
  // watch widget already shows. Cached for 5 minutes since wind doesn't
  // change minute-to-minute.
  const { data: serverPL } = useQuery({
    queryKey: ["hole-context-pl", tournamentId, hole.holeNumber],
    queryFn: async () => {
      if (!tournamentId || !token) return null;
      try {
        const res = await fetchPortal<{
          playsLikeYards?: number;
          playsLikeWindAdj?: number;
          playsLikeElevAdj?: number;
        }>(`/watch/hole-context?tournamentId=${tournamentId}&hole=${hole.holeNumber}`, token);
        if (res?.playsLikeYards == null) return null;
        return {
          playsLikeYards: res.playsLikeYards,
          windAdj: res.playsLikeWindAdj ?? 0,
          elevAdj: res.playsLikeElevAdj ?? 0,
          source: "server" as const,
        };
      } catch {
        return null; // graceful — fall back to local computation below
      }
    },
    enabled: !!(tournamentId && token && headerYards),
    staleTime: 5 * 60_000,
  });

  // Local wind+elev fallback (no temperature, no altitude — matches the
  // server contract). Only used when the server value is unavailable AND
  // the player has a live GPS fix to anchor the wind component against.
  const localPL = (() => {
    if (serverPL) return null;
    if (!headerYards || !weather) return null;
    if (userLat == null || userLng == null) return null;
    if (centreLat == null || centreLng == null) return null;
    // Match the server contract: only emit a fallback plays-like when BOTH
    // wind and elevation inputs are available. Otherwise we'd risk showing
    // a wind-only number on the phone that diverges from the watch.
    if (!pointElevations) return null;
    const bearing = bearingDegrees(userLat, userLng, centreLat, centreLng);
    const elevDiff = pointElevations.centre - pointElevations.user;
    const bd = playsLikeBreakdown(
      headerYards,
      weather.windSpeed,
      weather.windDirection,
      bearing,
      elevDiff,
      // Intentionally omit temperature + altitude so the headline number
      // matches the wind+elev-only formula the watch / Wear OS use.
    );
    return {
      playsLikeYards: bd.playsLikeYards,
      windAdj: bd.windAdj,
      elevAdj: bd.elevAdj,
      source: "local" as const,
    };
  })();

  const headerPL = serverPL ?? localPL;

  const showHeaderPLBreakdown = useCallback(() => {
    if (!headerPL || !headerYards) return;
    const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);
    const lines: string[] = [
      `Raw: ${headerYards} yds`,
      `Plays like: ${headerPL.playsLikeYards} yds`,
      "",
    ];
    if (headerPL.windAdj !== 0) lines.push(`Wind: ${sign(headerPL.windAdj)} yds`);
    if (headerPL.elevAdj !== 0) lines.push(`Elevation: ${sign(headerPL.elevAdj)} yds`);
    if (headerPL.windAdj === 0 && headerPL.elevAdj === 0) {
      lines.push("Conditions are neutral.");
    }
    if (headerPL.source === "local") {
      lines.push("", "Computed on-device from local weather.");
    }
    Alert.alert("Plays-like breakdown", lines.join("\n"));
  }, [headerPL, headerYards]);

  // Derive the AI-suggested club from club profile and current GPS distance
  const suggestedClubResult = distCentre && clubProfile && clubProfile.length > 0
    ? findSuggestedClubs(clubProfile, metersToYards(distCentre))
    : null;
  const suggestedClub = suggestedClubResult?.recommended ?? null;

  // Effective club: explicitly selected, or suggested, or null
  const effectiveClub = selectedClub ?? suggestedClub?.club ?? null;

  // Bearing from player to pin for the AI Caddie wind / aim model
  const bearingToPin = (userLat != null && userLng != null && pinLat != null && pinLng != null)
    ? bearingDegrees(userLat, userLng, pinLat, pinLng)
    : null;

  const animate = () => {
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 1.08, duration: 80, useNativeDriver: true }),
      Animated.timing(scaleAnim, { toValue: 1, duration: 80, useNativeDriver: true }),
    ]).start();
  };

  const adjust = (delta: number) => {
    const next = Math.max(1, Math.min(15, currentScore + delta));
    animate();
    if (delta > 0 && ndbCap !== null && next >= ndbCap) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    onScoreChange(next);
  };

  const handleLogShot = () => {
    onLogShot(
      selectedShotType,
      userLat ?? undefined,
      userLng ?? undefined,
      distCentre ?? undefined,
      effectiveClub ?? undefined,
      selectedMissDir ?? undefined,
      selectedLieType ?? undefined,
      selectedShotShape ?? undefined,
      selectedPenaltyReason ?? undefined,
    );
    // Reset selections for next shot
    setSelectedClub(null);
    setSelectedMissDir(null);
    setSelectedLieType(null);
    setSelectedShotShape(null);
    setSelectedPenaltyReason(null);
    setShowShotPanel(false);
  };

  return (
    <View style={styles.holeCard}>
      {/* Missing par warning */}
      {!hasPar && (
        <View style={styles.noParWarning}>
          <Feather name="alert-triangle" size={14} color="#92400e" />
          <Text style={styles.noParWarningText}>Hole data not configured — scores will not count for handicap.</Text>
        </View>
      )}

      {/* Weather strip */}
      {weather && (
        <View style={styles.weatherStripContainer}>
          <View style={styles.weatherStrip}>
            <Text style={styles.weatherIcon}>{weatherCodeToIcon(weather.weatherCode)}</Text>
            <Text style={styles.weatherText}>{Math.round(weather.temperature)}°C</Text>
            <Text style={styles.weatherSep}>·</Text>
            <Feather name="wind" size={12} color={Colors.muted} />
            <Text style={styles.weatherText}>{Math.round(weather.windSpeed)} km/h {windDegToCompass(weather.windDirection)}</Text>
            {weather.precipitation > 0 && (
              <>
                <Text style={styles.weatherSep}>·</Text>
                <Text style={styles.weatherText}>💧 {weather.precipitation.toFixed(1)}mm</Text>
              </>
            )}
            {weather.humidity !== undefined && (
              <>
                <Text style={styles.weatherSep}>·</Text>
                <Text style={styles.weatherText}>💧 {weather.humidity}%</Text>
              </>
            )}
          </View>
          {weather.alerts && weather.alerts.length > 0 && (
            <View style={styles.weatherAlertStrip}>
              <Text style={styles.weatherAlertText}>⚠️ {weather.alerts.join(" · ")}</Text>
            </View>
          )}
        </View>
      )}

      {/* Hole header */}
      <View style={styles.holeHeader}>
        <View style={styles.holeNumberBadge}>
          <Text style={styles.holeNumberLabel}>HOLE</Text>
          <Text style={styles.holeNumberValue}>{hole.holeNumber}</Text>
        </View>
        <View style={styles.holeInfoRight}>
          <View style={styles.parBadge}>
            <Text style={styles.parLabel}>PAR</Text>
            <Text style={styles.parValue}>{hole.par}</Text>
          </View>
          {hole.yardageWhite ? (
            <Pressable
              onPress={headerPL ? showHeaderPLBreakdown : undefined}
              hitSlop={6}
              accessibilityLabel={
                headerPL
                  ? `Plays like ${headerPL.playsLikeYards} yards. Tap for wind and elevation breakdown.`
                  : `${hole.yardageWhite} yards`
              }
            >
              <Text style={styles.yardage}>{hole.yardageWhite} yds</Text>
              {headerPL && headerYards != null && headerPL.playsLikeYards !== headerYards && (
                <Text
                  style={[
                    styles.yardagePlaysLike,
                    {
                      color: headerPL.playsLikeYards > headerYards
                        ? "#FBBF24"   // headwind/uphill = plays longer (amber)
                        : "#34D399",  // tailwind/downhill = plays shorter (green)
                    },
                  ]}
                >
                  plays {headerPL.playsLikeYards} ⓘ
                </Text>
              )}
            </Pressable>
          ) : null}
          {hole.handicap ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Text style={styles.hcpText}>SI {hole.handicap}</Text>
              {strokesReceived > 0 && (
                <View style={styles.allowanceBadge}>
                  <Text style={styles.allowanceBadgeText}>+{strokesReceived}</Text>
                </View>
              )}
            </View>
          ) : null}
        </View>
      </View>

      {/* GPS Distance to pin */}
      {distCentre !== null && (
        <View>
          <GpsDistanceRow
            distFrontM={distFront}
            distCentreM={distCentre}
            distBackM={distBack}
            plFront={plFront}
            plCentre={plCentre}
            plBack={plBack}
            hasPinOffset={hasPinOffset}
            usingCachedCourse={usingCachedCourse}
          />
          {onOpenMap && (
            <Pressable onPress={onOpenMap} style={styles.mapBtn}>
              <Feather name="map" size={13} color={Colors.primary} />
              <Text style={styles.mapBtnText}>{hasPinOffset ? "Hole Map · Pin set" : "View Hole Map"}</Text>
              <Feather name="chevron-right" size={13} color={Colors.primary} />
            </Pressable>
          )}
        </View>
      )}
      {/* Show Map button even without GPS distance (no user location) */}
      {distCentre === null && centreLat !== null && onOpenMap && (
        <Pressable onPress={onOpenMap} style={[styles.mapBtn, { marginHorizontal: 16, marginTop: 4 }]}>
          <Feather name="map" size={13} color={Colors.primary} />
          <Text style={styles.mapBtnText}>View Hole Map</Text>
          <Feather name="chevron-right" size={13} color={Colors.primary} />
        </Pressable>
      )}

      {/* AI Caddie recommendation card (Task #356) */}
      {distCentre !== null && (
        <CaddieCard
          token={token ?? null}
          distanceYards={metersToYards(distCentre)}
          windSpeedKmh={weather?.windSpeed ?? 0}
          windDirectionDeg={weather?.windDirection ?? 0}
          bearingToPinDeg={bearingToPin}
          pinLat={pinLat}
          // Pin elevation minus player elevation, converted to yards.
          // Uses the elevation interpolated to the actual pin position
          // (front/centre/back projected along the green's axis), so the
          // engine matches the hole-map "plays-like" indicator on sloped
          // greens. Open-Meteo reports metres; ~1.0936 yards per metre.
          elevationDeltaYards={pointElevations && pinElevation !== undefined
            ? (pinElevation - pointElevations.user) * 1.0936
            : null}
          // Player's current lie from the active shot context (defaults to
          // tee on hole start; rough/sand/etc. once the player sets it).
          lieType={selectedLieType ?? (selectedShotType === "tee" ? "Tee" : null)}
          holeNumber={hole.holeNumber}
          round={round ?? 1}
          tournamentId={tournamentId ?? null}
          generalPlayRoundId={generalPlayRoundId ?? null}
          courseId={courseId ?? null}
          usingCachedCourse={usingCachedCourse}
          onAimPointChange={onAimPointChange}
          onClubChosen={(club, accepted) => {
            setSelectedClub(club);
            onCaddieClubChosen?.(club, accepted);
          }}
        />
      )}

      {/* Score controls */}
      <View style={styles.scoreControls}>
        <Pressable
          onPress={() => adjust(-1)}
          style={({ pressed }) => [styles.scoreBtn, { opacity: pressed ? 0.7 : 1 }]}
        >
          <Feather name="minus" size={28} color={Colors.text} />
        </Pressable>

        <View>
          <Animated.View style={[styles.scoreDisplay, { transform: [{ scale: scaleAnim }], borderColor: scoreColor }]}>
            <Text style={[styles.scoreNumber, { color: scoreColor }]}>{currentScore}</Text>
            <Text style={[styles.scoreDiff, { color: scoreColor }]}>
              {!hasPar ? "—" : diff === 0 ? "E" : diff > 0 ? `+${diff}` : `${diff}`}
            </Text>
          </Animated.View>
          {isAtCap && (
            <View style={styles.maxBadge}>
              <Text style={styles.maxBadgeText}>MAX</Text>
            </View>
          )}
        </View>

        <Pressable
          onPress={() => adjust(1)}
          style={({ pressed }) => [styles.scoreBtn, { opacity: pressed ? 0.7 : isAtCap ? 0.4 : 1 }]}
        >
          <Feather name="plus" size={28} color={isAtCap ? Colors.muted : Colors.text} />
        </Pressable>
      </View>

      {/* Score label */}
      <View style={[styles.scoreLabelBadge, { backgroundColor: scoreColor + "25", borderColor: scoreColor + "50" }]}>
        <Text style={[styles.scoreLabelText, { color: scoreColor }]}>{scoreLabel}</Text>
      </View>

      {/* Putts entry — manual fallback when not using watch voice ("two putts").
          Bounded 0..min(strokes, 9). The set of chips grows with the strokes
          on the hole so a triple-bogey 7 can record up to 7 putts. */}
      {(() => {
        const maxPutts = Math.max(0, Math.min(currentScore, 9));
        const chips = Array.from({ length: maxPutts + 1 }, (_, i) => i);
        return (
          <View style={styles.puttsRow}>
            <Text style={styles.puttsLabel}>PUTTS</Text>
            <View style={styles.puttsChips}>
              {chips.map((n) => {
                const selected = putts === n;
                return (
                  <Pressable
                    key={n}
                    onPress={() => onPuttsChange(n)}
                    style={[styles.puttsChip, selected && styles.puttsChipActive]}
                  >
                    <Text style={[styles.puttsChipText, selected && { color: Colors.primary }]}>{n}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
      })()}

      {/* Shot tracking row */}
      <View style={styles.shotRow}>
        <Pressable onPress={() => setShowShotPanel(!showShotPanel)} style={styles.shotBtn}>
          <Feather name="crosshair" size={14} color={Colors.secondary} />
          <Text style={styles.shotBtnText}>Track Shot {shotCount > 0 ? `(${shotCount})` : ""}</Text>
        </Pressable>
        {onOpenReviewShots && (
          <Pressable onPress={onOpenReviewShots} style={styles.reviewShotsBtn}>
            <Feather name="list" size={14} color={Colors.primary} />
            <Text style={styles.reviewShotsBtnText}>Review Shots{shotCount > 0 ? ` (${shotCount})` : ""}</Text>
          </Pressable>
        )}
        <Pressable onPress={() => setShowInfo(!showInfo)} style={styles.infoBtn}>
          <Feather name="info" size={14} color={Colors.muted} />
        </Pressable>
      </View>

      {/* Per-hole Strokes Gained card */}
      {sgForHole && (
        <View style={styles.sgCard}>
          <View style={styles.sgCardHeader}>
            <Feather name="trending-up" size={12} color={Colors.primary} />
            <Text style={styles.sgCardTitle}>STROKES GAINED · HOLE {sgForHole.holeNumber}</Text>
          </View>
          <View style={styles.sgCardRow}>
            <SGStat label="Total" value={sgForHole.sgTotal} highlight />
            <SGStat label="OTT" value={sgForHole.sgOTT} />
            <SGStat label="App" value={sgForHole.sgApproach} />
            <SGStat label="ATG" value={sgForHole.sgATG} />
            <SGStat label="Putt" value={sgForHole.sgPutting} estimated={sgForHole.puttingEstimated} />
          </View>
          {sgForHole.puttingEstimated && (
            <Text style={styles.sgEstimateNote}>
              ~ Putt SG estimated from scorecard putt count. Log putts as shots for a measured value.
            </Text>
          )}
        </View>
      )}

      {/* Shot panel */}
      {showShotPanel && (
        <View style={styles.shotPanel}>
          {/* Shot type row */}
          <Text style={styles.shotPanelTitle}>SHOT TYPE</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.shotTypeRow}>
            {SHOT_TYPES.map((st) => (
              <Pressable
                key={st.key}
                onPress={() => setSelectedShotType(st.key as ShotType)}
                style={[styles.shotTypeChip, selectedShotType === st.key && styles.shotTypeChipActive]}
              >
                <Text style={[styles.shotTypeChipText, selectedShotType === st.key && { color: Colors.primary }]}>
                  {st.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          {/* AI Caddie card now lives at the top of HoleCard (Task #356) */}

          {/* Club picker — profile clubs first, then remaining standard clubs */}
          {(() => {
            const profileClubNames = (clubProfile ?? []).filter(e => e.club).map(e => e.club!);
            const remaining = STANDARD_CLUBS.filter(c => !profileClubNames.includes(c));
            const orderedClubs = profileClubNames.length > 0 ? [...profileClubNames, ...remaining] : STANDARD_CLUBS;
            return (
              <>
                <Text style={styles.shotPanelTitle}>CLUB{profileClubNames.length > 0 ? " (YOUR BAG)" : ""}</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.shotTypeRow}>
                  {orderedClubs.map((club) => {
                    const isSuggested = suggestedClub?.club === club && !selectedClub;
                    const isSelected = effectiveClub === club;
                    const inBag = profileClubNames.includes(club);
                    return (
                      <Pressable
                        key={club}
                        onPress={() => setSelectedClub(club === selectedClub ? null : club)}
                        style={[
                          styles.shotTypeChip,
                          isSelected && styles.shotTypeChipActive,
                          isSuggested && { borderColor: "rgba(201,168,76,0.6)", borderWidth: 1.5 },
                          !inBag && profileClubNames.length > 0 && { opacity: 0.55 },
                        ]}
                      >
                        <Text style={[styles.shotTypeChipText, isSelected && { color: Colors.primary }]}>
                          {club}
                        </Text>
                        {isSuggested && (
                          <Text style={{ fontSize: 8, color: "#C9A84C", marginTop: 1 }}>AI ✦</Text>
                        )}
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </>
            );
          })()}

          {/* Miss direction */}
          <Text style={styles.shotPanelTitle}>MISS DIRECTION</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.shotTypeRow}>
            {MISS_DIRECTIONS.map((dir) => (
              <Pressable
                key={dir}
                onPress={() => setSelectedMissDir(selectedMissDir === dir ? null : dir)}
                style={[styles.shotTypeChip, selectedMissDir === dir && styles.shotTypeChipActive]}
              >
                <Text style={[styles.shotTypeChipText, selectedMissDir === dir && { color: Colors.primary }]}>{dir}</Text>
              </Pressable>
            ))}
          </ScrollView>

          {/* Lie type */}
          <Text style={styles.shotPanelTitle}>LIE</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.shotTypeRow}>
            {LIE_TYPES.map((lie) => (
              <Pressable
                key={lie}
                onPress={() => setSelectedLieType(selectedLieType === lie ? null : lie)}
                style={[styles.shotTypeChip, selectedLieType === lie && styles.shotTypeChipActive]}
              >
                <Text style={[styles.shotTypeChipText, selectedLieType === lie && { color: Colors.primary }]}>{lie}</Text>
              </Pressable>
            ))}
          </ScrollView>

          {/* Shot shape */}
          <Text style={styles.shotPanelTitle}>SHAPE</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.shotTypeRow}>
            {SHOT_SHAPES.map((shape) => (
              <Pressable
                key={shape}
                onPress={() => setSelectedShotShape(selectedShotShape === shape ? null : shape)}
                style={[styles.shotTypeChip, selectedShotShape === shape && styles.shotTypeChipActive]}
              >
                <Text style={[styles.shotTypeChipText, selectedShotShape === shape && { color: Colors.primary }]}>{shape}</Text>
              </Pressable>
            ))}
          </ScrollView>

          {/* Penalty reason (shown when shot type is not standard play) */}
          <Text style={styles.shotPanelTitle}>PENALTY</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.shotTypeRow}>
            {PENALTY_REASONS.map((reason) => (
              <Pressable
                key={reason}
                onPress={() => setSelectedPenaltyReason(selectedPenaltyReason === reason ? null : reason)}
                style={[styles.shotTypeChip, selectedPenaltyReason === reason && styles.shotTypeChipActive]}
              >
                <Text style={[styles.shotTypeChipText, selectedPenaltyReason === reason && { color: Colors.primary }]}>{reason}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <Pressable onPress={handleLogShot} style={styles.logShotBtn}>
            <Feather name="plus-circle" size={16} color="#000" />
            <Text style={styles.logShotBtnText}>
              Log Shot{effectiveClub ? ` · ${effectiveClub}` : ""}
            </Text>
            {userLat && distCentre && (
              <Text style={styles.logShotDist}> · {metersToYards(distCentre)} yds</Text>
            )}
          </Pressable>
        </View>
      )}

      {/* Hole info card */}
      {showInfo && (
        <View style={styles.holeInfoCard}>
          {hole.description ? <Text style={styles.holeInfoDesc}>{hole.description}</Text> : null}
          <View style={styles.holeInfoGrid}>
            {hole.yardageBlue ? <View style={styles.holeInfoCell}><Text style={styles.holeInfoLabel}>Blue</Text><Text style={[styles.holeInfoVal, { color: "#60a5fa" }]}>{hole.yardageBlue}</Text></View> : null}
            {hole.yardageWhite ? <View style={styles.holeInfoCell}><Text style={styles.holeInfoLabel}>White</Text><Text style={[styles.holeInfoVal, { color: "#e5e7eb" }]}>{hole.yardageWhite}</Text></View> : null}
            {hole.yardageRed ? <View style={styles.holeInfoCell}><Text style={styles.holeInfoLabel}>Red</Text><Text style={[styles.holeInfoVal, { color: "#f87171" }]}>{hole.yardageRed}</Text></View> : null}
          </View>
          {centreLat && centreLng ? (
            <View style={styles.holeInfoGPS}>
              <Feather name="map-pin" size={12} color={Colors.primary} />
              <Text style={styles.holeInfoGPSText}>Green GPS: {centreLat.toFixed(4)}, {centreLng.toFixed(4)}</Text>
            </View>
          ) : (
            <Text style={styles.holeInfoNoGPS}>No green GPS data</Text>
          )}
        </View>
      )}

      {isSaving && (
        <View style={styles.savingOverlay}>
          <LoadingSpinner size="small" color={Colors.primary} />
        </View>
      )}
    </View>
  );
}

interface HoleResult { holeNumber: number; strokes: number; par: number; toPar: number; }

function ScoringScreen({
  session,
  onFinish,
  onBack,
}: {
  session: Session;
  onFinish: (holeResults: HoleResult[]) => void;
  onBack: () => void;
}) {
  const { token, user } = useAuth();
  const router = useRouter();
  const [currentHoleIdx, setCurrentHoleIdx] = useState(0);
  const [scores, setScores] = useState<Record<number, number>>({});
  const [putts, setPutts] = useState<Record<number, number>>({});
  // Wave 1 W1-B — per-hole `updatedAt` tracker. The server-side conflict
  // detector compares this against the row's `updatedAt`; when the server is
  // newer, it returns 409 with both versions so we can surface a "two devices
  // both edited this hole" dialog.
  const [scoreUpdatedAt, setScoreUpdatedAt] = useState<Record<number, string>>({});
  const [conflict, setConflict] = useState<null | {
    holeNumber: number;
    // Round defaults to the active session round for per-hole saves; the
    // batch-flush flow may surface conflicts from a different round if the
    // queue spans rounds, so the resolver must use this value rather than
    // assuming `session.round`.
    round: number;
    server: { strokes: number; putts: number | null; updatedAt: string };
    client: { strokes: number; putts: number | null };
  }>(null);
  // Wave 1 W1-B — pending conflicts surfaced by the offline batch flush. Each
  // entry stays in the local queue until the player resolves it via the
  // single-hole chooser modal (popped from this list, one at a time).
  const [batchConflicts, setBatchConflicts] = useState<BatchConflict[]>([]);
  const [saving, setSaving] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // GPS state
  const [userLocation, setUserLocation] = useState<Location.LocationObject | null>(null);
  const [locationGranted, setLocationGranted] = useState(false);
  const locationSub = useRef<Location.LocationSubscription | null>(null);

  // Auto shot-detection state — GPS samples are accumulated throughout the
  // round and POSTed to /portal/shots/detect at hole/round end so the engine
  // can fuse them with watch motion peaks. Sensitivity is user-tunable and
  // persisted in AsyncStorage.
  const gpsBuffer = useRef<Array<{ lat: number; lng: number; timestamp: number; accuracy?: number | null }>>([]);
  const [autoShotSensitivity, setAutoShotSensitivity] = useState<AutoShotSensitivity>("medium");
  const [autoShotProposals, setAutoShotProposals] = useState<DetectedShotProposal[] | null>(null);
  const [autoShotReviewOpen, setAutoShotReviewOpen] = useState(false);
  const [autoShotBusy, setAutoShotBusy] = useState(false);
  // Per-row editable state for the auto-detect review modal — players can
  // deselect a misfired proposal or tweak its shotType / club before
  // committing. Mirrors `autoShotProposals` 1:1 by index.
  const [autoShotEdits, setAutoShotEdits] = useState<Array<{
    selected: boolean;
    shotType: string;
    club: string | null;
  }>>([]);
  const [autoShotEditingIndex, setAutoShotEditingIndex] = useState<number | null>(null);
  // Task #525 — running auto-detect badge fed by /shots/ingest chunk responses.
  // The phone streams new GPS samples (everything past `gpsLastSentTs.current`)
  // every 5 minutes and on hole change; the server returns the cumulative
  // proposed-shot count which we surface as a small live badge in the header.
  const [autoShotRunningCount, setAutoShotRunningCount] = useState<number | null>(null);
  const gpsLastSentTs = useRef<number>(0);
  const gpsChunkInFlight = useRef<boolean>(false);

  // Weather state
  const [weather, setWeather] = useState<WeatherData | null>(null);

  // Shot tracking per hole
  const [shotsByHole, setShotsByHole] = useState<Record<number, ShotRecord[]>>({});
  const [pendingShots, setPendingShots] = useState<ShotRecord[]>([]);

  // Per-hole shot review modal
  const [reviewShotsHole, setReviewShotsHole] = useState<number | null>(null);

  // Offline indicator
  const [isOffline, setIsOffline] = useState(false);
  const [syncedBanner, setSyncedBanner] = useState(false);

  // Watch sync
  const [syncingWatch, setSyncingWatch] = useState(false);
  const [watchSynced, setWatchSynced] = useState(false);
  // Watch UX polish — toggles for haptic green-targeting, voice score entry,
  // and battery-saver mode. Persisted in AsyncStorage and pushed to the watch
  // via WatchBridge.pushSettings whenever they change.
  const [watchSettingsOpen, setWatchSettingsOpen] = useState(false);
  const [watchBatteryMode, setWatchBatteryMode] = useState(false);
  const [watchHapticTargeting, setWatchHapticTargeting] = useState(true);
  const [watchVoiceEntry, setWatchVoiceEntry] = useState(true);
  // Battery level (in percent) at or below which the watch auto-enables
  // battery mode. 30 % matches the watch-side default; player can adjust
  // 10–50 % from the Watch Settings modal (Task #420).
  const [watchBatteryAutoPct, setWatchBatteryAutoPct] = useState(30);
  // Task #825 — brief confirmation toast shown when the threshold (or any
  // other watch setting) round-trips back to the phone from the watch. We
  // never show this on initial mount or for phone-side changes — only when
  // the native bridge fires KharagolfWatchSettingsChanged.
  const [watchToast, setWatchToast] = useState<string | null>(null);
  const watchToastOpacity = useRef(new Animated.Value(0)).current;

  // Hydrate the auto-shot sensitivity setting on mount.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(AUTO_DETECT_SENSITIVITY_KEY);
        if (raw === "low" || raw === "medium" || raw === "high") {
          setAutoShotSensitivity(raw);
        }
      } catch {/* fresh install — defaults apply */}
    })();
  }, []);

  // Persist sensitivity whenever it changes.
  useEffect(() => {
    AsyncStorage.setItem(AUTO_DETECT_SENSITIVITY_KEY, autoShotSensitivity).catch(() => {});
  }, [autoShotSensitivity]);

  // Hydrate watch settings from AsyncStorage on mount.
  useEffect(() => {
    (async () => {
      try {
        const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
        const raw = await AsyncStorage.getItem("kharagolf_watch_settings");
        if (raw) {
          const j = JSON.parse(raw) as { batteryMode?: boolean; hapticTargeting?: boolean; voiceEntry?: boolean; batteryAutoPct?: number };
          if (typeof j.batteryMode === "boolean")     setWatchBatteryMode(j.batteryMode);
          if (typeof j.hapticTargeting === "boolean") setWatchHapticTargeting(j.hapticTargeting);
          if (typeof j.voiceEntry === "boolean")      setWatchVoiceEntry(j.voiceEntry);
          if (typeof j.batteryAutoPct === "number")   setWatchBatteryAutoPct(Math.max(10, Math.min(50, j.batteryAutoPct)));
        }
      } catch {/* fresh install — defaults apply */}
    })();
  }, []);

  // Persist + push to watch whenever a toggle flips.
  useEffect(() => {
    (async () => {
      try {
        const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
        await AsyncStorage.setItem("kharagolf_watch_settings", JSON.stringify({
          batteryMode:     watchBatteryMode,
          hapticTargeting: watchHapticTargeting,
          voiceEntry:      watchVoiceEntry,
          batteryAutoPct:  watchBatteryAutoPct,
        }));
        const { WatchBridge } = await import("../../modules/KharagolfWatchBridge");
        await WatchBridge.pushSettings({
          batteryMode:            watchBatteryMode,
          hapticTargetingEnabled: watchHapticTargeting,
          voiceEntryEnabled:      watchVoiceEntry,
          batteryAutoThreshold:   watchBatteryAutoPct / 100,
        });
      } catch {/* bridge unavailable in managed dev build */}
    })();
  }, [watchBatteryMode, watchHapticTargeting, watchVoiceEntry, watchBatteryAutoPct]);

  // Task #671 — listen for watch → phone battery auto-enable threshold
  // changes. When the player nudges the threshold from the watch UI, the
  // native bridge emits an event so the phone-side state matches and gets
  // re-persisted via the effect above (which makes the chosen value survive
  // a watch reinstall, since the next pushSettings call will replay it).
  useEffect(() => {
    let sub: { remove: () => void } | undefined;
    (async () => {
      try {
        const { subscribeWatchBatteryAutoPct } = await import("../../modules/KharagolfWatchBridge");
        sub = subscribeWatchBatteryAutoPct((clampedPct) => {
          setWatchBatteryAutoPct(clampedPct);
          // Task #825 — surface a brief confirmation so the player can see
          // the watch tweak made it back to the phone.
          setWatchToast(`Battery auto threshold set to ${clampedPct}% from your watch`);
        });
      } catch {/* bridge unavailable in managed dev build */}
    })();
    return () => { try { sub?.remove(); } catch {} };
  }, []);

  // Task #825 — fade the watch confirmation toast in, hold ~2.5s, fade out.
  useEffect(() => {
    if (!watchToast) return;
    watchToastOpacity.setValue(0);
    const inAnim = Animated.timing(watchToastOpacity, {
      toValue: 1, duration: 180, useNativeDriver: true,
    });
    const outAnim = Animated.timing(watchToastOpacity, {
      toValue: 0, duration: 220, useNativeDriver: true,
    });
    let cancelled = false;
    inAnim.start();
    const t = setTimeout(() => {
      if (cancelled) return;
      outAnim.start(({ finished }) => {
        if (finished && !cancelled) setWatchToast(null);
      });
    }, 2500);
    return () => {
      cancelled = true;
      clearTimeout(t);
      inAnim.stop();
      outAnim.stop();
    };
  }, [watchToast, watchToastOpacity]);

  // Marker Live View share
  const [sharingLive, setSharingLive] = useState(false);

  // Map & pin position state
  const [showMap, setShowMap] = useState(false);
  // AI Caddie aim points keyed by hole number (Task #356)
  const [aimPointsByHole, setAimPointsByHole] = useState<Record<number, AimPoint | null>>({});
  const [pinOffsets, setPinOffsets] = useState<Record<number, { lat: number; lng: number }>>({});

  // Load saved pin positions on session start
  useEffect(() => {
    const loadPins = async () => {
      try {
        const url = `/tournaments/${session.tournamentId}/players/${session.playerId}/rounds/${session.round}/pin-positions`;
        const positions = await fetchPortal<Array<{ holeNumber: number; latOffset: string; lngOffset: string }>>(url, token!);
        if (Array.isArray(positions) && positions.length > 0) {
          const map: Record<number, { lat: number; lng: number }> = {};
          positions.forEach(p => { map[p.holeNumber] = { lat: parseFloat(p.latOffset), lng: parseFloat(p.lngOffset) }; });
          setPinOffsets(map);
        }
      } catch { /* ignore, use default centre */ }
    };
    loadPins();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.tournamentId, session.playerId, session.round]);

  const handlePinSaved = async (holeNumber: number, latOffset: number, lngOffset: number) => {
    setPinOffsets(prev => ({ ...prev, [holeNumber]: { lat: latOffset, lng: lngOffset } }));
    try {
      await patchPortal(
        `/tournaments/${session.tournamentId}/players/${session.playerId}/rounds/${session.round}/hole/${holeNumber}/pin`,
        token!,
        { latOffset, lngOffset }
      );
    } catch { /* non-fatal */ }
  };

  // Task #1160 / Task #1332 — true once any in-round data path has fallen
  // back to the cached course bundle. We track each source independently so
  // a successful refetch on one path doesn't clear an indicator another path
  // is still showing, then OR them together for the round-level signal that
  // is threaded into GpsDistanceRow / CaddieCard / HoleMapSheet so the small
  // "saved course data" indicator stays consistent across the screen.
  const [holeMapUsingCachedCourse, setHoleMapUsingCachedCourse] = useState(false);
  const {
    data: holesData,
    isLoading,
    usingCachedCourse: holesUsingCachedCourse,
  } = useHolesWithCachedFallback({
    tournamentId: session.tournamentId,
    round: session.round,
  });
  const usingCachedCourse = holesUsingCachedCourse || holeMapUsingCachedCourse;

  const { data: clubProfile } = useQuery({
    queryKey: ["portal-club-profile-scoring", session.playerId],
    queryFn: () => fetchPortal<ClubProfileEntry[]>("/club-profile", token!),
    enabled: !!token,
    staleTime: 5 * 60 * 1000,
  });

  const { data: sgRound, refetch: refetchSg } = useQuery<SGRoundResponse>({
    queryKey: ["portal-sg-round", session.tournamentId, session.round],
    queryFn: () => fetchPortal<SGRoundResponse>(
      `/sg/round?round=${session.round}&tournamentId=${session.tournamentId}`,
      token!,
    ),
    enabled: !!token,
    staleTime: 30 * 1000,
  });

  const { data: watchStatus } = useQuery<{
    appleWatch: { connected: boolean } | null;
    wearOS: { connected: boolean } | null;
  }>({
    queryKey: ["watch-status-score"],
    queryFn: () => fetchPortal("/watch/status", token!),
    enabled: !!token,
    staleTime: 30 * 1000,
  });

  const watchConnected =
    watchStatus?.appleWatch?.connected === true ||
    watchStatus?.wearOS?.connected === true;

  // Request GPS permission and start watching. We request *background* in
  // addition to foreground so the OS will keep delivering samples to our
  // TaskManager task when the player has the screen off mid-round; the
  // foreground subscription handles the in-app distance/aim UI. Background
  // is best-effort: if the player declines, we fall back to foreground-only.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return;
      if (cancelled) return;
      setLocationGranted(true);
      locationSub.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 5 },
        (loc) => {
          setUserLocation(loc);
          // Buffer the sample for end-of-round auto shot detection.
          gpsBuffer.current.push({
            lat: loc.coords.latitude,
            lng: loc.coords.longitude,
            timestamp: loc.timestamp ?? Date.now(),
            accuracy: loc.coords.accuracy ?? null,
          });
          // Hard cap to prevent unbounded growth on a long round (~5h ≈ 3600 samples at 5s).
          if (gpsBuffer.current.length > 6000) {
            gpsBuffer.current = gpsBuffer.current.slice(-6000);
          }
        }
      );

      // Best-effort background tracking — the OS will deliver samples to
      // BACKGROUND_LOCATION_TASK while the screen is off. If the player
      // declines background permission we keep foreground tracking only.
      try {
        const bg = await Location.requestBackgroundPermissionsAsync();
        if (bg.status === "granted" && !cancelled) {
          const already = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK).catch(() => false);
          if (!already) {
            await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
              accuracy: Location.Accuracy.High,
              timeInterval: 5000,
              distanceInterval: 5,
              showsBackgroundLocationIndicator: true,
              foregroundService: {
                notificationTitle: "KHARAGOLF — recording your round",
                notificationBody: "GPS samples are being buffered for auto shot detection.",
              },
              pausesUpdatesAutomatically: false,
            });
          }
        }
      } catch {/* background unavailable on this platform — foreground covers us */}
    })();
    return () => {
      cancelled = true;
      locationSub.current?.remove();
      // Stop the background task when the screen unmounts (round abandoned).
      Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)
        .then(async (on) => { if (on) await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK); })
        .catch(() => {});
    };
  }, []);

  // Accelerometer-based motion peak producer — when the player swings, the
  // phone (typically in a pocket or bag attached to the cart) sees a spike
  // in acceleration magnitude. We post peaks to /portal/watch/motion so
  // the same buffer that wearables push into is filled even when no real
  // watch is connected. This gives the auto-detect engine a motion signal
  // out of the box.
  useEffect(() => {
    if (!token) return;
    let lastPeakAt = 0;
    let pending: Array<{ timestamp: number; peakG: number }> = [];
    let flushTimer: ReturnType<typeof setInterval> | null = null;

    Accelerometer.setUpdateInterval(100); // 10Hz is enough to catch swing peaks
    const sub = Accelerometer.addListener(({ x, y, z }) => {
      // Magnitude in g, subtract 1g for gravity baseline.
      const g = Math.sqrt(x * x + y * y + z * z);
      const peak = Math.abs(g - 1);
      if (peak < 0.4) return; // noise floor
      const now = Date.now();
      // Debounce — at most one peak per 800ms (a swing + follow-through).
      if (now - lastPeakAt < 800) return;
      lastPeakAt = now;
      pending.push({ timestamp: now, peakG: peak });
      if (pending.length > 100) pending = pending.slice(-100);
    });

    flushTimer = setInterval(async () => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      try {
        await postPortal("/watch/motion", token, { events: batch });
      } catch {
        // Re-queue on failure so the next flush retries; cap to avoid OOM.
        pending = [...batch, ...pending].slice(-200);
      }
    }, 15_000);

    return () => {
      sub.remove();
      if (flushTimer) clearInterval(flushTimer);
    };
  }, [token]);

  // On mount, drain any GPS samples the background task buffered while
  // the app was suspended/killed and merge them into the in-memory buffer.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(BACKGROUND_GPS_BUFFER_KEY);
        if (!raw) return;
        const buffered: Array<{ lat: number; lng: number; timestamp: number; accuracy?: number | null }> = JSON.parse(raw);
        if (Array.isArray(buffered) && buffered.length > 0) {
          gpsBuffer.current = [...gpsBuffer.current, ...buffered].slice(-6000);
        }
        await AsyncStorage.removeItem(BACKGROUND_GPS_BUFFER_KEY);
      } catch {/* corrupt/missing — fine, just start fresh */}
    })();
  }, []);

  // Fetch weather once when we have a location
  useEffect(() => {
    if (!userLocation || weather) return;
    const { latitude, longitude } = userLocation.coords;
    fetchPublic<WeatherData>(`/weather?lat=${latitude}&lng=${longitude}`)
      .then(setWeather)
      .catch(() => {});
  }, [userLocation, weather]);

  // Hydrate per-hole shot counts from server so the Review Shots button reflects
  // shots logged in previous sessions or pushed from the watch — not just shots
  // logged in this live session. Server is the source of truth: any hole the
  // server returns overwrites local state so deletes/edits resequence cleanly.
  const hydrateShotsFromServer = useCallback(async () => {
    if (!token) return;
    try {
      const groups = await fetchPortal<Array<{ hole: number; shots: ServerShot[] }>>(
        `/rounds/${session.round}/shots?tournamentId=${session.tournamentId}`,
        token,
      );
      if (!Array.isArray(groups)) return;
      const map: Record<number, ShotRecord[]> = {};
      for (const g of groups) {
        map[g.hole] = g.shots.map(s => ({
          tournamentId: session.tournamentId,
          playerId: session.playerId,
          round: s.round,
          holeNumber: s.holeNumber,
          shotNumber: s.shotNumber,
          shotType: s.shotType as ShotType,
          club: s.club,
          missDirection: s.missDirection,
          lieType: s.lieType,
          shotShape: s.shotShape,
          penaltyReason: s.penaltyReason,
          latitude: null,
          longitude: null,
          distanceToPin: s.distanceToPin ? parseFloat(s.distanceToPin) : null,
          recordedAt: new Date().toISOString(),
        }));
      }
      // Rebuild shotsByHole entirely from server: holes the server omits have
      // no shots (e.g. after deleting the last shot on a hole), so they must
      // be cleared locally too. This keeps shot numbering and the Review Shots
      // count in sync with server-side resequencing.
      const next: Record<number, ShotRecord[]> = {};
      for (const h of (holesData?.holes ?? [])) next[h.holeNumber] = [];
      for (const [holeNum, shots] of Object.entries(map)) {
        next[Number(holeNum)] = shots;
      }
      setShotsByHole(next);
    } catch {/* offline — keep local state */}
  }, [token, session.tournamentId, session.playerId, session.round, holesData?.holes]);

  useEffect(() => {
    hydrateShotsFromServer();
  }, [hydrateShotsFromServer]);

  // AppState: flush offline queue when app comes to foreground
  useEffect(() => {
    // Load persisted shots on mount
    loadPersistedShots(session.tournamentId, session.playerId).then(persisted => {
      if (persisted.length > 0) setPendingShots(prev => [...prev, ...persisted]);
    }).catch(() => {});

    const showSynced = () => {
      setSyncedBanner(true);
      setTimeout(() => setSyncedBanner(false), 2500);
    };

    const sub = AppState.addEventListener("change", async (nextState) => {
      if (nextState === "active") {
        const result = await flushOfflineQueue(session.tournamentId, session.playerId, token ?? undefined);
        if (result.synced > 0) { setIsOffline(false); showSynced(); }
        if (result.conflicts.length > 0) setBatchConflicts(prev => mergeBatchConflicts(prev, result.conflicts));
      }
    });
    // Flush immediately on mount
    flushOfflineQueue(session.tournamentId, session.playerId, token ?? undefined).then(result => {
      if (result.synced > 0) { setIsOffline(false); showSynced(); }
      if (result.conflicts.length > 0) setBatchConflicts(prev => mergeBatchConflicts(prev, result.conflicts));
    }).catch(() => {});
    return () => sub.remove();
  }, [session.tournamentId, session.playerId, token]);

  // AI Caddie offline lifecycle (Task #356):
  //   - prefetch the player's caddie model snapshot at round start so the
  //     recommendation card can compute on-device when offline
  //   - flush any queued caddie feedback POSTs
  useEffect(() => {
    if (!token) return;
    prefetchSnapshot(token, session.tournamentId, null, session.round).catch(() => {});
    flushFeedbackQueue(token).catch(() => {});
    const sub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        flushFeedbackQueue(token).catch(() => {});
      }
    });
    return () => sub.remove();
  }, [token, session.tournamentId, session.round]);

  // Share Live View — generates a marker share token and opens the native Share Sheet.
  const handleShareLiveView = useCallback(async () => {
    if (!token || sharingLive) return;
    setSharingLive(true);
    try {
      const result = await postPortal<{ token: string; shareUrl: string }>(
        "/scoring/live-share",
        token,
        { tournamentId: session.tournamentId, round: session.round }
      );
      if (result?.shareUrl) {
        await Share.share({
          message: `Follow ${session.playerName}'s live scorecard: ${result.shareUrl}`,
          url: result.shareUrl,
          title: "Live Scorecard",
        });
      }
    } catch {
      Alert.alert("Unable to generate share link", "Please try again.");
    } finally {
      setSharingLive(false);
    }
  }, [token, session.tournamentId, session.round, session.playerName, sharingLive]);

  // Push current scores to watch via /portal/watch/sync.
  // The server returns a fresh watchToken; we push it to the watch via WCSession/Data Layer.
  const handleSyncToWatch = async () => {
    if (!token || syncingWatch) return;
    setSyncingWatch(true);
    try {
      const result = await postPortal<{ ok: boolean; watchToken?: string }>(
        "/watch/sync",
        token,
        { platform: Platform.OS === "android" ? "wear_os" : "apple_watch" }
      );
      // Push the fresh token to the paired watch via WCSession/Data Layer
      if (result?.watchToken) {
        try {
          const { WatchBridge } = await import("../../modules/KharagolfWatchBridge");
          await WatchBridge.pushToken(result.watchToken);
        } catch (_) {
          // Native bridge unavailable in managed dev build — watch re-pairs on expiry
        }
      }
      setWatchSynced(true);
      setTimeout(() => setWatchSynced(false), 2500);
    } catch (_) {
      // silent — watch will pick up score on next poll
    } finally {
      setSyncingWatch(false);
    }
  };

  // Load existing scores
  useEffect(() => {
    fetchPublic<Array<{ holeNumber: number; strokes: number; putts?: number | null; updatedAt?: string | null }>>(
      `/tournaments/${session.tournamentId}/players/${session.playerId}/scores`
    ).then((existingScores) => {
      const scoreMap: Record<number, number> = {};
      const puttsMap: Record<number, number> = {};
      const updatedAtMap: Record<number, string> = {};
      existingScores.forEach((s) => {
        scoreMap[s.holeNumber] = s.strokes;
        if (s.putts != null) puttsMap[s.holeNumber] = s.putts;
        if (s.updatedAt) updatedAtMap[s.holeNumber] = s.updatedAt;
      });
      setScores(scoreMap);
      setPutts(puttsMap);
      setScoreUpdatedAt(updatedAtMap);
      // Jump to first unscored hole
      if (holesData?.holes?.length) {
        const firstUnscored = holesData.holes.findIndex(h => !scoreMap[h.holeNumber]);
        if (firstUnscored >= 0) setCurrentHoleIdx(firstUnscored);
      }
    }).catch(() => {});
  }, [session.tournamentId, session.playerId, holesData?.holes]);

  // Wave 1 W1-B — pre-cache the offline course bundle when the round starts.
  // Once holes load we know the courseId + organizationId; the bundle util
  // honours a 24h TTL and falls back to any prior cache on network failure
  // so the player can keep playing through patchy reception.
  useEffect(() => {
    const courseId = holesData?.courseId ?? null;
    const orgId = holesData?.organizationId ?? session.organizationId ?? null;
    if (!courseId || !orgId || !token) return;
    prefetchCourseBundle(orgId, courseId, {
      token,
      tournamentId: session.tournamentId,
    }).catch(() => { /* best-effort — cache is purely an offline aid */ });
  }, [holesData?.courseId, holesData?.organizationId, session.organizationId, session.tournamentId, token]);

  const holes = holesData?.holes ?? [];
  const currentHole = holes[currentHoleIdx];
  const totalHoles = holes.length;

  // Derive Course Handicap using WHS formula: round(HI * slope/113 + (CR - coursePar))
  const hiNum = session.handicapIndex ?? null;
  const courseSlope = holesData?.courseSlope ?? 113;
  const courseRating = holesData?.courseRating ?? null;
  const coursePar = holesData?.coursePar ?? null;
  const derivedCourseHandicap: number | null =
    hiNum !== null && courseRating !== null && coursePar !== null
      ? Math.round(hiNum * (courseSlope / 113) + (courseRating - coursePar))
      : hiNum !== null
      ? Math.round(hiNum) // fallback: use HI directly when course CR/slope unavailable
      : null;

  // Setup warning: check if any holes are missing par data
  const hasMissingParHoles = holes.some(h => !h.par || h.par === 0);

  // Push current hole context to watch whenever the active hole changes.
  useEffect(() => {
    if (!currentHole || !watchConnected) return;
    (async () => {
      try {
        const { WatchBridge } = await import("../../modules/KharagolfWatchBridge");
        await WatchBridge.pushHoleContext(
          session.tournamentId,
          session.playerId,
          session.round,
          currentHole.holeNumber,
          currentHole.par,
        );
      } catch (_) {
        // Bridge unavailable in managed dev build — watch fetches context on next poll
      }
    })();
  }, [currentHole?.holeNumber, watchConnected]);

  // ── Task #431 — Watch heart-rate sampler control ────────────────────
  // When the user has opted in to HR capture (Stats > Heart-Rate & Stress),
  // tell the paired watch to start streaming samples for this round and stop
  // again on unmount, on round finish, or if the toggle flips off mid-round.
  // We re-check /health-prefs whenever the app comes to foreground so a flip
  // made on the stats screen takes effect without restarting the round.
  const hrCaptureRef = useRef<boolean>(false);
  const hrEvaluateRef = useRef<(() => Promise<void>) | null>(null);

  // Re-evaluate whenever the scoring screen regains navigation focus so
  // toggling capture on the Stats tab takes effect without backgrounding.
  useFocusEffect(
    useCallback(() => {
      hrEvaluateRef.current?.().catch(() => {});
    }, []),
  );

  const buildHrContext = useCallback(() => {
    const cur = currentHole?.holeNumber ?? null;
    const nextShotNumber = cur != null
      ? ((shotsByHole[cur]?.length ?? 0) + (pendingShots.filter(s => s.holeNumber === cur).length) + 1)
      : 1;
    return {
      tournamentId: session.tournamentId,
      playerId:     session.playerId,
      round:        session.round,
      holeNumber:   cur,
      shotNumber:   nextShotNumber,
    };
  }, [session.tournamentId, session.playerId, session.round, currentHole?.holeNumber, shotsByHole, pendingShots]);

  // Stop the watch sampler on unmount — covers the round-abandoned path
  // (back button, app killed, navigation away) so the watch isn't left
  // burning battery streaming HR with no listener.
  useEffect(() => {
    return () => {
      if (!hrCaptureRef.current) return;
      hrCaptureRef.current = false;
      (async () => {
        try {
          const { WatchBridge } = await import("../../modules/KharagolfWatchBridge");
          // Task #1187: the native bridge owns the
          // `/hr-samples/session` action="end" POST as part of hrStop
          // (see plugins/withWatchBridge.js postHrSessionMarker on
          // both iOS and Android). The duplicate JS-layer POST that
          // used to live here was removed so each hrStop fires exactly
          // one session marker request on real devices.
          await WatchBridge.hrStop();
        } catch {/* bridge unavailable */}
      })();
    };
    // token intentionally omitted: cleanup captures whatever token was
    // active at mount; if it changes mid-round we still want to end the
    // original session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync HR capture state with /health-prefs.captureEnabled. Re-fetches on
  // mount and whenever the app comes back to the foreground so the toggle
  // honours mid-round changes from the Stats screen.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const evaluate = async () => {
      try {
        const prefs = await fetchPortal<{ captureEnabled: boolean }>("/health-prefs", token);
        if (cancelled) return;
        const wantOn = !!prefs?.captureEnabled;
        if (wantOn && !hrCaptureRef.current) {
          const { WatchBridge } = await import("../../modules/KharagolfWatchBridge");
          // Task #1187: the native bridge POSTs
          // `/hr-samples/session` action="start" itself as part of
          // hrStart (see plugins/withWatchBridge.js
          // postHrSessionMarker on both iOS and Android), so the
          // duplicate JS-layer POST that used to live here was removed.
          // One hrStart on a real device now produces exactly one
          // session marker request.
          await WatchBridge.hrStart(token, BASE_URL, buildHrContext());
          hrCaptureRef.current = true;
        } else if (!wantOn && hrCaptureRef.current) {
          const { WatchBridge } = await import("../../modules/KharagolfWatchBridge");
          // Task #1187: hrStop similarly owns the action="end" POST in
          // the native bridge, so the duplicate JS-layer POST is gone.
          await WatchBridge.hrStop();
          hrCaptureRef.current = false;
        }
      } catch {/* offline or bridge unavailable — try again next foreground */}
    };
    evaluate();
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") evaluate(); });
    // Expose evaluate so the focus effect below can re-run it whenever the
    // scoring screen regains focus (covers in-app toggle changes from the
    // Stats screen without needing the app to background/foreground first).
    hrEvaluateRef.current = evaluate;
    return () => { cancelled = true; sub.remove(); hrEvaluateRef.current = null; };
    // buildHrContext intentionally omitted: we re-push context from the next
    // effect whenever it changes. Re-running this on every shot would spam
    // the /health-prefs endpoint.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Push fresh tagging context to the watch whenever the active hole or the
  // shot-count for that hole changes, so each subsequent batch carries the
  // right per-shot metadata.
  useEffect(() => {
    if (!hrCaptureRef.current) return;
    (async () => {
      try {
        const { WatchBridge } = await import("../../modules/KharagolfWatchBridge");
        await WatchBridge.hrPushContext(buildHrContext());
      } catch {/* bridge unavailable */}
    })();
  }, [buildHrContext]);

  // Reconcile watch-submitted scores every 15 s while paired.
  useEffect(() => {
    if (!watchConnected) return;
    const interval = setInterval(async () => {
      try {
        const latest = await fetchPublic<Array<{ holeNumber: number; strokes: number; putts?: number | null; updatedAt?: string | null }>>(
          `/tournaments/${session.tournamentId}/players/${session.playerId}/scores`
        );
        setScoreUpdatedAt(prev => {
          const updated = { ...prev };
          let changed = false;
          latest.forEach(s => {
            if (s.updatedAt && updated[s.holeNumber] !== s.updatedAt) {
              updated[s.holeNumber] = s.updatedAt;
              changed = true;
            }
          });
          return changed ? updated : prev;
        });
        setScores(prev => {
          const updated = { ...prev };
          let changed = false;
          latest.forEach(s => {
            if (updated[s.holeNumber] !== s.strokes) {
              updated[s.holeNumber] = s.strokes;
              changed = true;
            }
          });
          return changed ? updated : prev;
        });
        // Hydrate watch-recorded putts ("two putts" voice events) into the
        // mobile scorecard so the chip selection reflects what the watch sent.
        setPutts(prev => {
          const updated = { ...prev };
          let changed = false;
          latest.forEach(s => {
            if (s.putts != null && updated[s.holeNumber] !== s.putts) {
              updated[s.holeNumber] = s.putts;
              changed = true;
            }
          });
          return changed ? updated : prev;
        });
      } catch (_) {}
    }, 15_000);
    return () => clearInterval(interval);
  }, [watchConnected, session.tournamentId, session.playerId]);

  const saveScore = useCallback(async (holeNumber: number, strokes: number, puttCount?: number, knownAtOverride?: string) => {
    setSaving(holeNumber);
    // Always queue locally first — include putts when provided so the offline
    // batch flush replays them too. `knownAtOverride` lets in-tick callers
    // (e.g. resolveConflict) bypass the stale-state-closure issue by passing
    // the just-learned server `updatedAt` directly instead of relying on the
    // not-yet-flushed `scoreUpdatedAt` setState.
    const effectiveKnownAt = knownAtOverride ?? scoreUpdatedAt[holeNumber];
    await enqueueScore({ tournamentId: session.tournamentId, playerId: session.playerId, round: session.round, holeNumber, strokes, putts: puttCount, timestamp: Date.now(), clientKnownAt: effectiveKnownAt });
    try {
      const body: Record<string, unknown> = { round: session.round, holeNumber, strokes };
      if (puttCount !== undefined) body.putts = puttCount;
      // Wave 1 W1-B — include the locally-known `updatedAt` so the server
      // can detect "two devices both edited this hole" conflicts (HTTP 409).
      if (effectiveKnownAt) body.clientKnownAt = effectiveKnownAt;

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const resp = await fetch(
        `${BASE_URL}/api/public/tournaments/${session.tournamentId}/players/${session.playerId}/scores`,
        { method: "POST", headers, body: JSON.stringify(body) },
      );

      if (resp.status === 409) {
        // Surface the conflict so the player can pick which value sticks.
        // Last-write-wins is still the eventual behaviour — this dialog just
        // exposes the divergence that would otherwise silently clobber the
        // other device's entry.
        const payload = await resp.json().catch(() => ({})) as {
          server?: { strokes: number; putts?: number | null; updatedAt?: string };
          client?: { strokes: number; putts?: number | null };
        };
        if (payload?.server) {
          setConflict({
            holeNumber,
            round: session.round,
            server: {
              strokes: payload.server.strokes,
              putts: payload.server.putts ?? null,
              updatedAt: payload.server.updatedAt ?? new Date().toISOString(),
            },
            client: {
              strokes: payload.client?.strokes ?? strokes,
              putts: payload.client?.putts ?? puttCount ?? null,
            },
          });
        }
        return;
      }
      if (!resp.ok) throw new Error(`Score save failed (${resp.status})`);

      // Capture the new server `updatedAt` so the next save for this hole
      // sends the up-to-date `clientKnownAt`.
      const saved = await resp.json().catch(() => null) as { updatedAt?: string } | null;
      if (saved?.updatedAt) {
        setScoreUpdatedAt(prev => ({ ...prev, [holeNumber]: saved.updatedAt! }));
      }

      // Remove from offline queue if server succeeded
      const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
      if (raw) {
        const queue = (JSON.parse(raw) as OfflineScore[]).filter((q) => !(q.tournamentId === session.tournamentId && q.playerId === session.playerId && q.round === session.round && q.holeNumber === holeNumber));
        await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
      }
      setIsOffline(false);
    } catch {
      setIsOffline(true);
    } finally {
      setSaving(null);
    }
  }, [session, token, scoreUpdatedAt]);

  // Wave 1 W1-B — resolve a sync conflict the server flagged on the last
  // save. "Keep mine" re-sends the same strokes/putts but with the server's
  // newer `updatedAt` as `clientKnownAt`, so the second attempt succeeds and
  // the player's value wins. "Use theirs" simply adopts the server's values
  // locally without firing another POST.
  const resolveConflict = useCallback(async (choice: "mine" | "theirs") => {
    if (!conflict) return;
    const { holeNumber, round: conflictRound, server, client } = conflict;
    // scoreUpdatedAt is keyed by hole only and is only consulted for saves on
    // the active session round, so updating it for a different round is a
    // harmless no-op rather than a correctness issue.
    if (conflictRound === session.round) {
      setScoreUpdatedAt(prev => ({ ...prev, [holeNumber]: server.updatedAt }));
    }
    // If this hole+round is also queued in the batch-flush conflict list
    // (i.e. the dialog was opened from the "N holes had conflicts — review"
    // banner), drop it now that the player has chosen a winner. Key by both
    // round and hole so cross-round queues resolve the right entry.
    setBatchConflicts(prev => prev.filter(c => !(c.holeNumber === holeNumber && c.round === conflictRound)));
    if (choice === "theirs") {
      // Only mirror server values into the visible scorecard when the
      // conflict belongs to the round the player is currently scoring.
      if (conflictRound === session.round) {
        setScores(prev => ({ ...prev, [holeNumber]: server.strokes }));
        setPutts(prev => {
          const next = { ...prev };
          if (server.putts != null) next[holeNumber] = server.putts;
          else delete next[holeNumber];
          return next;
        });
      }
      // Drop the stale offline-queue entry too — we've adopted the server's
      // value, so there's nothing left to replay. Match on the conflict's
      // round, not session.round.
      try {
        const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
        if (raw) {
          const queue = (JSON.parse(raw) as OfflineScore[]).filter(q => !(
            q.tournamentId === session.tournamentId &&
            q.playerId === session.playerId &&
            q.round === conflictRound &&
            q.holeNumber === holeNumber
          ));
          await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
        }
      } catch {/* best-effort */}
      setConflict(null);
      return;
    }
    setConflict(null);
    // "Keep mine" — re-fire the save with the server's newer updatedAt
    // adopted as clientKnownAt so the next POST passes the freshness check.
    // For the active session round, saveScore handles it; for a queued
    // conflict from a different round, post directly so we don't accidentally
    // write to the wrong round. Pass `server.updatedAt` explicitly to
    // saveScore: the `setScoreUpdatedAt` call above is queued and won't be
    // visible to saveScore's stale closure on this same tick, so without
    // the override the re-POST would carry the previous (stale) clientKnownAt
    // and 409 again. See __tests__/score-batch-conflict-chooser.test.tsx.
    if (conflictRound === session.round) {
      await saveScore(holeNumber, client.strokes, client.putts ?? undefined, server.updatedAt);
      return;
    }
    try {
      const body: Record<string, unknown> = {
        round: conflictRound,
        holeNumber,
        strokes: client.strokes,
        clientKnownAt: server.updatedAt,
      };
      if (client.putts != null) body.putts = client.putts;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const resp = await fetch(
        `${BASE_URL}/api/public/tournaments/${session.tournamentId}/players/${session.playerId}/scores`,
        { method: "POST", headers, body: JSON.stringify(body) },
      );
      if (resp.ok) {
        // Clear the now-resolved offline-queue entry for this round/hole.
        const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
        if (raw) {
          const queue = (JSON.parse(raw) as OfflineScore[]).filter(q => !(
            q.tournamentId === session.tournamentId &&
            q.playerId === session.playerId &&
            q.round === conflictRound &&
            q.holeNumber === holeNumber
          ));
          await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
        }
      }
    } catch {/* leave queued — next flush will retry */}
  }, [conflict, saveScore, session.tournamentId, session.playerId, session.round, token]);

  // Wave 1 W1-B — open the per-hole chooser modal with the next pending
  // batch-flush conflict. Each resolution pops one entry; the banner stays
  // visible until the list is empty. Round is carried through so the
  // resolver can target the right offline-queue row even when the queue
  // spans rounds (the flush filters by tournament+player, not round).
  const reviewNextBatchConflict = useCallback(() => {
    if (batchConflicts.length === 0) return;
    const next = batchConflicts[0];
    setConflict({ holeNumber: next.holeNumber, round: next.round, server: next.server, client: next.client });
  }, [batchConflicts]);

  const handleScoreChange = useCallback((strokes: number) => {
    if (!currentHole) return;
    setScores(prev => ({ ...prev, [currentHole.holeNumber]: strokes }));
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => saveScore(currentHole.holeNumber, strokes), 500);
  }, [currentHole, saveScore]);

  const handlePuttsChange = useCallback((puttCount: number) => {
    if (!currentHole) return;
    setPutts(prev => ({ ...prev, [currentHole.holeNumber]: puttCount }));
    const strokes = scores[currentHole.holeNumber] ?? currentHole.par;
    saveScore(currentHole.holeNumber, strokes, puttCount);
  }, [currentHole, scores, saveScore]);

  // Shot tracking
  const handleLogShot = useCallback(async (
    shotType: ShotType,
    lat?: number, lng?: number, distToPin?: number,
    club?: string, missDirection?: string, lieType?: string, shotShape?: string, penaltyReason?: string,
  ) => {
    if (!currentHole) return;
    const existingShots = shotsByHole[currentHole.holeNumber] ?? [];
    const shotNum = existingShots.length + 1;
    const newShot: ShotRecord = {
      tournamentId: session.tournamentId,
      playerId: session.playerId,
      round: session.round,
      holeNumber: currentHole.holeNumber,
      shotNumber: shotNum,
      shotType,
      club: club ?? null,
      missDirection: missDirection ?? null,
      lieType: lieType ?? null,
      shotShape: shotShape ?? null,
      penaltyReason: penaltyReason ?? null,
      latitude: lat ?? null,
      longitude: lng ?? null,
      distanceToPin: distToPin ?? null,
      recordedAt: new Date().toISOString(),
    };
    setShotsByHole(prev => ({ ...prev, [currentHole.holeNumber]: [...existingShots, newShot] }));
    try {
      await postPortal("/watch/submit-shot", token ?? "", {
        tournamentId: session.tournamentId,
        playerId: session.playerId,
        round: session.round,
        holeNumber: currentHole.holeNumber,
        shotNumber: shotNum,
        shotType,
        club: club ?? null,
        missDirection: missDirection ?? null,
        lieType: lieType ?? null,
        shotShape: shotShape ?? null,
        penaltyReason: penaltyReason ?? null,
        latitude: lat ?? null,
        longitude: lng ?? null,
        distanceToPin: distToPin ?? null,
      });
      refetchSg().catch(() => {});
    } catch (e) {
      // Task #469 — when GPS consent is withdrawn the API blocks shot ingestion.
      // Don't queue the shot for later replay (consent decision is intentional);
      // instead surface a one-tap link to the consent centre.
      if (e instanceof ConsentRequiredError) {
        setShotsByHole(prev => {
          const next = { ...prev };
          next[currentHole.holeNumber] = (next[currentHole.holeNumber] ?? []).filter(s => s !== newShot);
          return next;
        });
        Alert.alert(
          "GPS consent required",
          e.message,
          [
            { text: "Cancel", style: "cancel" },
            { text: "Open Consent Settings", onPress: () => router.push("/my-360/consents") },
          ],
        );
        return;
      }
      // Persist to AsyncStorage so shots survive app restarts
      setPendingShots(prev => [...prev, newShot]);
      await enqueueShot(newShot).catch(() => {});
    }
  }, [currentHole, shotsByHole, session, token]);

  const goNext = useCallback(async () => {
    if (!currentHole) return;
    const s = scores[currentHole.holeNumber] ?? currentHole.par;
    if (!scores[currentHole.holeNumber]) {
      setScores(prev => ({ ...prev, [currentHole.holeNumber]: s }));
      await saveScore(currentHole.holeNumber, s);
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    if (currentHoleIdx < totalHoles - 1) {
      setCurrentHoleIdx(currentHoleIdx + 1);
    }
  }, [currentHole, scores, currentHoleIdx, totalHoles, saveScore]);

  const goPrev = useCallback(() => {
    if (currentHoleIdx > 0) setCurrentHoleIdx(currentHoleIdx - 1);
  }, [currentHoleIdx]);

  // Task #525 — push the unsent tail of `gpsBuffer.current` to the server
  // as a chunk so the auto-detect engine can run over a growing buffer mid
  // round (instead of one fragile mega-upload at the end). Idempotent: the
  // server dedupes by sample timestamp, so a retried chunk is a no-op.
  const flushGPSChunk = useCallback(async () => {
    if (!token) return;
    if (gpsChunkInFlight.current) return;
    const lastTs = gpsLastSentTs.current;
    const chunk = gpsBuffer.current.filter(s => s.timestamp > lastTs);
    if (chunk.length === 0) return;
    gpsChunkInFlight.current = true;
    // Only mark as sent up to what we actually shipped — protects us if a
    // response races with new background-buffered samples.
    const newHigh = chunk[chunk.length - 1].timestamp;
    try {
      const resp = await postPortal<{ ok: boolean; proposedCount?: number }>(
        "/shots/ingest",
        token,
        {
          tournamentId: session.tournamentId,
          round: session.round,
          gps: chunk,
          sensitivity: autoShotSensitivity,
        },
      );
      gpsLastSentTs.current = Math.max(gpsLastSentTs.current, newHigh);
      if (typeof resp?.proposedCount === "number") {
        setAutoShotRunningCount(resp.proposedCount);
      }
    } catch {
      // Network blip — leave gpsLastSentTs untouched so the same samples
      // re-ship on the next flush. Server will dedupe by timestamp.
    } finally {
      gpsChunkInFlight.current = false;
    }
  }, [token, session.tournamentId, session.round, autoShotSensitivity]);

  // Periodic chunk upload (every 5 minutes) — the workhorse for streaming
  // samples while the player is walking the course. Hole-change flushes
  // (below) cover the "got reception now" recovery case.
  useEffect(() => {
    if (!token) return;
    const id = setInterval(() => { flushGPSChunk().catch(() => {}); }, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [token, flushGPSChunk]);

  // Flush on hole change so the badge feels responsive ("you finished hole
  // 3 → here are the 4 shots we caught"). Skip the very first render so we
  // don't fire an empty chunk on session boot.
  const lastFlushedHoleIdx = useRef<number>(-1);
  useEffect(() => {
    if (!token) return;
    if (lastFlushedHoleIdx.current === -1) {
      lastFlushedHoleIdx.current = currentHoleIdx;
      return;
    }
    if (lastFlushedHoleIdx.current !== currentHoleIdx) {
      lastFlushedHoleIdx.current = currentHoleIdx;
      flushGPSChunk().catch(() => {});
    }
  }, [currentHoleIdx, token, flushGPSChunk]);

  // Run auto shot detection over the buffered GPS samples (and any watch
  // motion peaks the server has buffered for this user). Returns proposals
  // without persisting them; caller decides whether to commit.
  const runAutoShotDetection = useCallback(async (): Promise<DetectedShotProposal[] | null> => {
    if (!token || gpsBuffer.current.length < 5) return null;
    try {
      const resp = await postPortal<{ ok: boolean; proposed: DetectedShotProposal[] }>(
        "/shots/detect",
        token,
        {
          tournamentId: session.tournamentId,
          round: session.round,
          gps: gpsBuffer.current,
          sensitivity: autoShotSensitivity,
          commit: false,
        }
      );
      return resp?.proposed ?? [];
    } catch {
      return null;
    }
  }, [token, session.tournamentId, session.round, autoShotSensitivity]);

  // Commit a previously-proposed set of shots to the server. Returns true on
  // success so the caller can advance the round-finish flow only when the
  // commit actually persisted; on failure the review modal stays open so the
  // player can retry or skip.
  const commitAutoShots = useCallback(async (): Promise<boolean> => {
    if (!token || gpsBuffer.current.length === 0) return true;
    // Build the accepted subset from the player's edits in the review modal.
    // Only selected rows are sent; shotType/club may have been tweaked.
    // The mapping is centralised in buildAcceptedShotsPayload so the
    // round-end review payload contract is unit-testable in isolation
    // (see __tests__/autoShotPayload.test.ts — Task #689).
    const accepted = buildAcceptedShotsPayload(autoShotProposals ?? [], autoShotEdits);
    if (accepted.length === 0) {
      // Nothing selected — treat as a skip.
      gpsBuffer.current = [];
      setAutoShotReviewOpen(false);
      setAutoShotProposals(null);
      setAutoShotEdits([]);
      return true;
    }
    setAutoShotBusy(true);
    try {
      await postPortal(
        "/shots/detect",
        token,
        {
          tournamentId: session.tournamentId,
          round: session.round,
          gps: gpsBuffer.current,
          sensitivity: autoShotSensitivity,
          commit: true,
          acceptedShots: accepted,
        }
      );
      // Clear the buffer once committed so a subsequent detection doesn't
      // re-propose the same shots.
      gpsBuffer.current = [];
      gpsLastSentTs.current = 0;
      setAutoShotRunningCount(null);
      setAutoShotBusy(false);
      setAutoShotReviewOpen(false);
      setAutoShotProposals(null);
      setAutoShotEdits([]);
      return true;
    } catch {
      setAutoShotBusy(false);
      Alert.alert("Auto-detect", "Could not save proposed shots. Try again, or skip to finish without saving.");
      return false;
    }
  }, [token, session.tournamentId, session.round, autoShotSensitivity, autoShotProposals, autoShotEdits]);

  const handleFinish = useCallback(async () => {
    setSubmitting(true);
    if (currentHole && !scores[currentHole.holeNumber]) {
      await saveScore(currentHole.holeNumber, currentHole.par);
    }
    // Flush offline queue and pending shots
    const flushResult = await flushOfflineQueue(session.tournamentId, session.playerId, token ?? undefined);
    if (flushResult.conflicts.length > 0) setBatchConflicts(prev => mergeBatchConflicts(prev, flushResult.conflicts));
    if (pendingShots.length > 0) {
      try {
        await postPublic(`/tournaments/${session.tournamentId}/players/${session.playerId}/shots/batch`, { shots: pendingShots });
        setPendingShots([]);
        await clearPersistedShots(session.tournamentId, session.playerId).catch(() => {});
      } catch {}
    }
    // Auto shot detection — run before finishing so the player can review
    // proposed shots before the round summary is shown. The review modal
    // commits or discards on its own; we only block the finish flow when
    // there are actually proposals to look at.
    const proposals = await runAutoShotDetection();
    setSubmitting(false);
    if (proposals && proposals.length > 0) {
      setAutoShotProposals(proposals);
      // Default: every proposal is selected, type/club come from the engine.
      setAutoShotEdits(proposals.map(p => ({
        selected: true,
        shotType: p.shotType,
        club: p.club ?? null,
      })));
      setAutoShotReviewOpen(true);
      // Defer onFinish until the user closes the review modal.
      return;
    }
    const holeResults: HoleResult[] = holes
      .filter(h => scores[h.holeNumber] !== undefined)
      .map(h => ({ holeNumber: h.holeNumber, strokes: scores[h.holeNumber], par: h.par, toPar: scores[h.holeNumber] - h.par }));
    onFinish(holeResults);
  }, [currentHole, scores, saveScore, onFinish, session, pendingShots, holes, token, runAutoShotDetection]);

  const finalizeAfterAutoReview = useCallback(() => {
    setAutoShotReviewOpen(false);
    setAutoShotProposals(null);
    setAutoShotEdits([]);
    setAutoShotEditingIndex(null);
    const holeResults: HoleResult[] = holes
      .filter(h => scores[h.holeNumber] !== undefined)
      .map(h => ({ holeNumber: h.holeNumber, strokes: scores[h.holeNumber], par: h.par, toPar: scores[h.holeNumber] - h.par }));
    onFinish(holeResults);
  }, [holes, scores, onFinish]);

  // Summary stats
  const scoredHoles = holes.filter(h => scores[h.holeNumber] !== undefined);
  const totalStrokes = scoredHoles.reduce((sum, h) => sum + (scores[h.holeNumber] ?? 0), 0);
  const totalPar = scoredHoles.reduce((sum, h) => sum + h.par, 0);
  const totalToPar = totalStrokes - totalPar;

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={Colors.primary} />
        <Text style={styles.loadingText}>Loading course data...</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {/* Wave 1 W1-B — sync-conflict resolver. Shown when the server detects
          another device wrote a newer score for the same hole. */}
      <Modal
        visible={!!conflict}
        transparent
        animationType="fade"
        onRequestClose={() => setConflict(null)}
      >
        <View style={styles.conflictBackdrop}>
          <View style={styles.conflictCard}>
            <Text style={styles.conflictTitle}>Score conflict</Text>
            {conflict ? (
              <>
                <Text style={styles.conflictBody}>
                  Hole {conflict.holeNumber} was also updated on another
                  device. Pick which value to keep.
                </Text>
                <View style={styles.conflictRow}>
                  <Pressable
                    style={[styles.conflictBtn, { borderColor: Colors.primary }]}
                    onPress={() => resolveConflict("mine")}
                  >
                    <Text style={styles.conflictBtnLabel}>Keep mine</Text>
                    <Text style={styles.conflictBtnValue}>
                      {conflict.client.strokes} strokes
                      {conflict.client.putts != null ? ` · ${conflict.client.putts} putts` : ""}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[styles.conflictBtn, { borderColor: Colors.muted }]}
                    onPress={() => resolveConflict("theirs")}
                  >
                    <Text style={styles.conflictBtnLabel}>Use theirs</Text>
                    <Text style={styles.conflictBtnValue}>
                      {conflict.server.strokes} strokes
                      {conflict.server.putts != null ? ` · ${conflict.server.putts} putts` : ""}
                    </Text>
                  </Pressable>
                </View>
              </>
            ) : null}
          </View>
        </View>
      </Modal>
      {/* Wave 1 W1-B — banner shown when the offline batch flush returned
          409s for one or more queued holes. Tapping it pops the per-hole
          chooser modal so the player can resolve each one. */}
      {batchConflicts.length > 0 ? (
        <Pressable onPress={reviewNextBatchConflict} style={styles.batchConflictBanner}>
          <Feather name="alert-triangle" size={14} color={Colors.bogey} />
          <Text style={styles.batchConflictText}>
            {batchConflicts.length} {batchConflicts.length === 1 ? "hole" : "holes"} had conflicts — review
          </Text>
        </Pressable>
      ) : null}
      {/* Task #825 — brief watch->phone confirmation toast */}
      {watchToast ? (
        <Animated.View
          pointerEvents="box-none"
          style={[styles.watchToast, { opacity: watchToastOpacity }]}
        >
          <Pressable onPress={() => setWatchToast(null)} style={styles.watchToastInner}>
            <Text style={{ fontSize: 14 }}>⌚</Text>
            <Text style={styles.watchToastText} numberOfLines={2}>{watchToast}</Text>
          </Pressable>
        </Animated.View>
      ) : null}
      {/* Side games live standings (skins/snake/wolf/nassau) */}
      <SideGamesPanel
        scope={{ tournamentId: session.tournamentId, round: session.round }}
        token={token ?? null}
        isAdmin={false}
        currentUserId={user?.id ?? null}
        currentHole={currentHole?.holeNumber ?? null}
      />
      {/* Session header */}
      <View style={styles.sessionHeader}>
        <Pressable onPress={onBack} style={styles.backBtn}>
          <Feather name="x" size={20} color={Colors.textSecondary} />
        </Pressable>
        <View style={{ flex: 1, marginHorizontal: 12 }}>
          <Text style={styles.sessionName} numberOfLines={1}>{session.playerName}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={styles.sessionTournament} numberOfLines={1}>{session.tournamentName}</Text>
            {isOffline && (
              <View style={styles.offlinePill}>
                <Feather name="wifi-off" size={10} color={Colors.bogey} />
                <Text style={styles.offlinePillText}>OFFLINE</Text>
              </View>
            )}
            {syncedBanner && (
              <View style={[styles.offlinePill, { backgroundColor: "rgba(34,197,94,0.18)" }]}>
                <Feather name="check-circle" size={10} color={Colors.primary} />
                <Text style={[styles.offlinePillText, { color: Colors.primary }]}>Synced!</Text>
              </View>
            )}
            {watchConnected && (
              <View style={[styles.offlinePill, { backgroundColor: "rgba(201,168,76,0.18)", borderColor: "rgba(201,168,76,0.3)", borderWidth: 1 }]}>
                <Text style={{ fontSize: 9 }}>⌚</Text>
                <Text style={[styles.offlinePillText, { color: "#C9A84C" }]}>{watchSynced ? "Synced!" : "Watch"}</Text>
              </View>
            )}
            {autoShotRunningCount !== null && autoShotRunningCount > 0 && (
              <View
                style={[styles.offlinePill, { backgroundColor: "rgba(34,197,94,0.18)", borderColor: "rgba(34,197,94,0.3)", borderWidth: 1 }]}
                accessibilityLabel={`${autoShotRunningCount} shots auto-detected so far`}
              >
                <Feather name="target" size={9} color={Colors.primary} />
                <Text style={[styles.offlinePillText, { color: Colors.primary }]}>{autoShotRunningCount} auto</Text>
              </View>
            )}
          </View>
        </View>
        {watchConnected && (
          <Pressable
            onPress={handleSyncToWatch}
            onLongPress={() => setWatchSettingsOpen(true)}
            disabled={syncingWatch}
            style={[styles.rulesIconBtn, { marginRight: 4, opacity: syncingWatch ? 0.5 : 1 }]}
            hitSlop={8}
          >
            <Text style={{ fontSize: 16 }}>⌚</Text>
          </Pressable>
        )}
        {token && scoredHoles.length > 0 && (
          session.markerPlayerId
            ? (
              // Pre-assigned marker: show "Marker notified" status badge instead of share button
              <View style={{ flexDirection: "row", alignItems: "center", gap: 3, marginRight: 4, backgroundColor: "rgba(201,168,76,0.12)", borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 }}>
                <Feather name="user-check" size={12} color={Colors.primary} />
                <Text style={{ fontSize: 10, color: Colors.primary, fontFamily: "Inter_600SemiBold" }}>Marker notified</Text>
              </View>
            )
            : (
              // No pre-assigned marker: show Share Live View button
              <Pressable
                onPress={handleShareLiveView}
                disabled={sharingLive}
                style={[styles.rulesIconBtn, { marginRight: 4, opacity: sharingLive ? 0.5 : 1 }]}
                hitSlop={8}
              >
                {sharingLive
                  ? <LoadingSpinner size="small" color={Colors.primary} />
                  : <Feather name="share-2" size={18} color={Colors.primary} />
                }
              </Pressable>
            )
        )}
        <Pressable
          onPress={() => router.push("/(tabs)/rules")}
          style={styles.rulesIconBtn}
          hitSlop={8}
        >
          <Feather name="book-open" size={20} color="#C9A84C" />
        </Pressable>
        <View style={styles.sessionScore}>
          <Text style={[styles.sessionScoreValue, { color: totalToPar < 0 ? Colors.birdie : totalToPar > 0 ? Colors.bogey : Colors.par }]}>
            {scoredHoles.length > 0 ? (totalToPar === 0 ? "E" : totalToPar > 0 ? `+${totalToPar}` : `${totalToPar}`) : "-"}
          </Text>
          <Text style={styles.sessionScoreLabel}>{scoredHoles.length}/{totalHoles}</Text>
        </View>
      </View>

      {/* Progress bar */}
      <View style={styles.progressBar}>
        <View style={[styles.progressFill, { width: `${(scoredHoles.length / Math.max(totalHoles, 1)) * 100}%` }]} />
      </View>

      {/* Missing par warning — shown at top of scoring when course holes lack par data */}
      {hasMissingParHoles && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#fef3c7", paddingVertical: 8, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: "#f59e0b" }}>
          <Feather name="alert-triangle" size={14} color="#92400e" />
          <Text style={{ flex: 1, fontSize: 12, color: "#92400e", fontFamily: "Inter_600SemiBold" }}>
            Some holes are missing par data — those scores won't count for handicap.
          </Text>
        </View>
      )}

      {/* Sponsor banner — sold inventory on the mid-round scorecard */}
      {session.organizationId ? (
        <InlineAdBanner
          orgId={session.organizationId}
          slotKey="mobile_scorecard_banner"
          tournamentId={session.tournamentId}
          height={56}
          style={{ marginHorizontal: 12, marginTop: 6 }}
        />
      ) : null}

      {/* Hole navigation dots */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.holeDots}
      >
        {holes.map((h, idx) => {
          const s = scores[h.holeNumber];
          const isScored = s !== undefined;
          const isCurrent = idx === currentHoleIdx;
          const diff = isScored ? s - h.par : null;
          let dotColor = Colors.surface;
          if (isScored) {
            if (diff! < 0) dotColor = Colors.birdie;
            else if (diff! === 0) dotColor = Colors.par;
            else if (diff! === 1) dotColor = Colors.bogey;
            else dotColor = Colors.doubleOrWorse;
          }
          const sgHole = sgRound?.holes.find(sh => sh.holeNumber === h.holeNumber);
          const sgTotal = sgHole?.sgTotal ?? 0;
          const showSg = !!sgHole && Math.abs(sgTotal) >= 0.05;
          const sgIndicatorColor = sgTotal > 0 ? Colors.birdie : Colors.doubleOrWorse;

          return (
            <Pressable
              key={h.holeNumber}
              onPress={() => setCurrentHoleIdx(idx)}
              style={[
                styles.holeDot,
                { backgroundColor: dotColor, borderColor: isCurrent ? Colors.primary : Colors.border },
                isCurrent && styles.holeDotCurrent,
              ]}
              accessibilityLabel={
                showSg
                  ? `Hole ${h.holeNumber}, strokes gained ${sgTotal > 0 ? "+" : ""}${sgTotal.toFixed(2)}`
                  : `Hole ${h.holeNumber}`
              }
            >
              <Text style={[styles.holeDotText, isCurrent && { color: Colors.primary }]}>
                {h.holeNumber}
              </Text>
              {showSg && (
                <View
                  style={[
                    styles.holeDotSgBadge,
                    { backgroundColor: sgIndicatorColor },
                  ]}
                />
              )}
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Round-level Strokes Gained strip — shows the day so far at a glance */}
      {sgRound?.totals && sgRound.shotsTracked > 0 && (
        <View style={styles.sgTotalsStrip}>
          <View style={styles.sgTotalsHeader}>
            <Feather name="trending-up" size={11} color={Colors.primary} />
            <Text style={styles.sgTotalsTitle}>STROKES GAINED · ROUND</Text>
            <Text style={styles.sgTotalsShots}>{sgRound.shotsTracked} shot{sgRound.shotsTracked === 1 ? "" : "s"}</Text>
          </View>
          <View style={styles.sgTotalsRow}>
            <SGStat label="Total" value={sgRound.totals.sgTotal} highlight />
            <SGStat label="OTT" value={sgRound.totals.sgOTT} />
            <SGStat label="App" value={sgRound.totals.sgApproach} />
            <SGStat label="ATG" value={sgRound.totals.sgATG} />
            <SGStat label="Putt" value={sgRound.totals.sgPutting} estimated={sgRound.totals.puttingEstimated} />
          </View>
          {sgRound.totals.puttingEstimated && (
            <Text style={styles.sgEstimateNote}>
              ~ Some holes' Putt SG was estimated from your scorecard putt count.
            </Text>
          )}
        </View>
      )}

      {/* Main hole card */}
      <ScrollView
        contentContainerStyle={styles.scoringContent}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        {currentHole && (
          <HoleCard
            hole={currentHole}
            score={scores[currentHole.holeNumber] ?? null}
            putts={putts[currentHole.holeNumber] ?? null}
            onScoreChange={handleScoreChange}
            onPuttsChange={handlePuttsChange}
            isSaving={saving === currentHole.holeNumber}
            userLocation={userLocation}
            onLogShot={handleLogShot}
            shotCount={(shotsByHole[currentHole.holeNumber] ?? []).length}
            weather={weather}
            clubProfile={clubProfile}
            courseHandicap={derivedCourseHandicap}
            onOpenMap={() => setShowMap(true)}
            pinLatOffset={pinOffsets[currentHole.holeNumber]?.lat ?? 0}
            pinLngOffset={pinOffsets[currentHole.holeNumber]?.lng ?? 0}
            token={token}
            tournamentId={session.tournamentId}
            generalPlayRoundId={null}
            round={session.round}
            courseId={holesData?.courseId ?? null}
            usingCachedCourse={usingCachedCourse}
            onAimPointChange={(aim) => setAimPointsByHole(prev => ({ ...prev, [currentHole.holeNumber]: aim }))}
            sgForHole={sgRound?.holes.find(h => h.holeNumber === currentHole.holeNumber) ?? null}
            onOpenReviewShots={() => setReviewShotsHole(currentHole.holeNumber)}
          />
        )}
        {currentHole && (
          <View style={{ paddingHorizontal: 16 }}>
            <AutoHoleHrStrip
              token={token ?? null}
              tournamentId={session.tournamentId}
              round={session.round}
              holeNumber={currentHole.holeNumber}
            />
          </View>
        )}
      </ScrollView>

      {/* Navigation */}
      <View style={styles.navBar}>
        <Pressable
          onPress={goPrev}
          disabled={currentHoleIdx === 0}
          style={[styles.navBtn, currentHoleIdx === 0 && { opacity: 0.3 }]}
        >
          <Feather name="chevron-left" size={24} color={Colors.text} />
          <Text style={styles.navBtnText}>Prev</Text>
        </Pressable>

        {currentHoleIdx === totalHoles - 1 ? (
          <Pressable
            onPress={handleFinish}
            disabled={submitting}
            style={styles.finishBtn}
          >
            {submitting ? (
              <LoadingSpinner size="small" color="#000" />
            ) : (
              <>
                <Ionicons name="checkmark-circle" size={20} color="#000" />
                <Text style={styles.finishBtnText}>Submit Round</Text>
              </>
            )}
          </Pressable>
        ) : (
          <Pressable onPress={goNext} style={styles.nextBtn}>
            <Text style={styles.nextBtnText}>Next Hole</Text>
            <Feather name="chevron-right" size={24} color={Colors.primary} />
          </Pressable>
        )}
      </View>

      {/* Hole Map Sheet */}
      {currentHole && (
        <HoleMapSheet
          visible={showMap}
          onClose={() => setShowMap(false)}
          hole={currentHole}
          userLat={userLocation?.coords.latitude ?? null}
          userLng={userLocation?.coords.longitude ?? null}
          weather={weather ?? undefined}
          tournamentId={session.tournamentId}
          playerId={session.playerId}
          roundNumber={session.round}
          courseId={holesData?.courseId ?? undefined}
          token={token ?? undefined}
          savedPinLatOffset={pinOffsets[currentHole.holeNumber]?.lat ?? 0}
          savedPinLngOffset={pinOffsets[currentHole.holeNumber]?.lng ?? 0}
          onPinSaved={(lat, lng) => handlePinSaved(currentHole.holeNumber, lat, lng)}
          aimPoint={aimPointsByHole[currentHole.holeNumber] ?? null}
          onUsingCachedCourseChange={setHoleMapUsingCachedCourse}
        />
      )}

      {/* Auto shot detection review — shown at round end when GPS samples
          (and any buffered watch motion peaks) produce one or more proposed
          shots. The user can commit them to their shot history or dismiss. */}
      <Modal
        visible={autoShotReviewOpen}
        transparent
        animationType="slide"
        onRequestClose={finalizeAfterAutoReview}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: Colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '80%', padding: 18 }}>
            <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 18, color: Colors.text, marginBottom: 4 }}>
              Auto-detected shots
            </Text>
            <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textSecondary, marginBottom: 12 }}>
              We found {autoShotProposals?.length ?? 0} proposed shots from your phone GPS{` `}
              and watch motion. Review and save to your shot history, or skip.
            </Text>
            <ScrollView style={{ maxHeight: 360 }}>
              {(autoShotProposals ?? []).map((p, idx) => {
                const edit = autoShotEdits[idx] ?? { selected: true, shotType: p.shotType, club: p.club ?? null };
                const isEditing = autoShotEditingIndex === idx;
                return (
                  <View
                    key={`${p.holeNumber}-${p.shotNumber}-${idx}`}
                    style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      {/* Checkbox — toggles whether this proposal will be saved */}
                      <Pressable
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: edit.selected }}
                        accessibilityLabel={`Include hole ${p.holeNumber} shot ${p.shotNumber}`}
                        onPress={() => setAutoShotEdits(prev => prev.map((e, i) => i === idx ? { ...e, selected: !e.selected } : e))}
                        hitSlop={8}
                        style={{
                          width: 22, height: 22, borderRadius: 5, marginRight: 10,
                          borderWidth: 2,
                          borderColor: edit.selected ? Colors.primary : Colors.muted,
                          backgroundColor: edit.selected ? Colors.primary : 'transparent',
                          alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        {edit.selected ? <Feather name="check" size={14} color="#000" /> : null}
                      </Pressable>
                      <Pressable
                        onPress={() => setAutoShotEditingIndex(isEditing ? null : idx)}
                        style={{ flex: 1, opacity: edit.selected ? 1 : 0.45 }}
                        accessibilityRole="button"
                        accessibilityLabel={`Edit shot type or club for hole ${p.holeNumber} shot ${p.shotNumber}`}
                      >
                        <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.text }}>
                          Hole {p.holeNumber} · Shot {p.shotNumber}
                        </Text>
                        <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textSecondary }}>
                          {edit.shotType.toUpperCase()}
                          {edit.club ? ` · ${edit.club}` : ''}
                          {' · '}{p.distanceToPinYards.toFixed(0)} yds · {p.source}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => setAutoShotEditingIndex(isEditing ? null : idx)}
                        hitSlop={8}
                        style={{ marginLeft: 6, padding: 4 }}
                        accessibilityRole="button"
                        accessibilityLabel="Edit"
                      >
                        <Feather name={isEditing ? 'chevron-up' : 'edit-2'} size={15} color={Colors.muted} />
                      </Pressable>
                      <Text style={{ fontFamily: 'Inter_500Medium', fontSize: 11, color: Colors.muted, marginLeft: 8 }}>
                        {(p.confidence * 100).toFixed(0)}%
                      </Text>
                    </View>

                    {isEditing ? (
                      <View style={{ marginTop: 10, paddingHorizontal: 4 }}>
                        <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 11, color: Colors.textSecondary, marginBottom: 6 }}>SHOT TYPE</Text>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                          {SHOT_TYPES.map(st => {
                            const active = edit.shotType === st.key;
                            return (
                              <Pressable
                                key={st.key}
                                onPress={() => setAutoShotEdits(prev => prev.map((e, i) => i === idx ? { ...e, shotType: st.key } : e))}
                                style={{
                                  paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
                                  backgroundColor: active ? Colors.primary : '#333',
                                }}
                              >
                                <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 11, color: active ? '#000' : '#fff' }}>{st.label}</Text>
                              </Pressable>
                            );
                          })}
                        </View>
                        <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 11, color: Colors.textSecondary, marginTop: 10, marginBottom: 6 }}>CLUB</Text>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                          <View style={{ flexDirection: 'row', gap: 6 }}>
                            <Pressable
                              onPress={() => setAutoShotEdits(prev => prev.map((e, i) => i === idx ? { ...e, club: null } : e))}
                              style={{
                                paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
                                backgroundColor: edit.club === null ? Colors.primary : '#333',
                              }}
                            >
                              <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 11, color: edit.club === null ? '#000' : '#fff' }}>—</Text>
                            </Pressable>
                            {STANDARD_CLUBS.map(c => {
                              const active = edit.club === c;
                              return (
                                <Pressable
                                  key={c}
                                  onPress={() => setAutoShotEdits(prev => prev.map((e, i) => i === idx ? { ...e, club: c } : e))}
                                  style={{
                                    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14,
                                    backgroundColor: active ? Colors.primary : '#333',
                                  }}
                                >
                                  <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 11, color: active ? '#000' : '#fff' }}>{c}</Text>
                                </Pressable>
                              );
                            })}
                          </View>
                        </ScrollView>
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </ScrollView>
            {(() => {
              const selectedCount = autoShotEdits.filter(e => e.selected).length;
              return (
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 14, alignItems: 'center' }}>
                  <Text style={{ flex: 1, fontFamily: 'Inter_500Medium', fontSize: 11, color: Colors.textSecondary }}>
                    {selectedCount} of {autoShotEdits.length} selected
                  </Text>
                  <Pressable
                    onPress={finalizeAfterAutoReview}
                    disabled={autoShotBusy}
                    style={{ paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10, backgroundColor: '#444', alignItems: 'center', opacity: autoShotBusy ? 0.5 : 1 }}
                  >
                    <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 14, color: '#fff' }}>Skip All</Text>
                  </Pressable>
                  <Pressable
                    onPress={async () => {
                      const ok = await commitAutoShots();
                      if (ok) finalizeAfterAutoReview();
                    }}
                    disabled={autoShotBusy || selectedCount === 0}
                    style={{ paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10, backgroundColor: Colors.primary, alignItems: 'center', opacity: (autoShotBusy || selectedCount === 0) ? 0.5 : 1 }}
                  >
                    <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 14, color: '#000' }}>
                      {autoShotBusy ? 'Saving…' : `Save ${selectedCount}`}
                    </Text>
                  </Pressable>
                </View>
              );
            })()}
          </View>
        </View>
      </Modal>

      {/* Watch UX polish — long-press the watch icon to open this. */}
      <Modal
        visible={watchSettingsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setWatchSettingsOpen(false)}
      >
        <Pressable
          onPress={() => setWatchSettingsOpen(false)}
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 20 }}
        >
          <Pressable onPress={(e) => e.stopPropagation()} style={{ backgroundColor: Colors.surface, borderRadius: 16, padding: 18, gap: 14 }}>
            <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 16, color: Colors.text }}>⌚ Watch Settings</Text>

            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.text }}>Haptic green-targeting</Text>
                <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textSecondary, marginTop: 2 }}>
                  Pulse the watch faster as you turn toward the pin.
                </Text>
              </View>
              <Pressable
                onPress={() => setWatchHapticTargeting((v) => !v)}
                style={{ width: 44, height: 26, borderRadius: 13, backgroundColor: watchHapticTargeting ? Colors.primary : '#444', justifyContent: 'center', paddingHorizontal: 3 }}
              >
                <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff', alignSelf: watchHapticTargeting ? 'flex-end' : 'flex-start' }} />
              </Pressable>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.text }}>Voice score entry</Text>
                <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textSecondary, marginTop: 2 }}>
                  Say "log par on 7", "birdie", or "two putts".
                </Text>
              </View>
              <Pressable
                onPress={() => setWatchVoiceEntry((v) => !v)}
                style={{ width: 44, height: 26, borderRadius: 13, backgroundColor: watchVoiceEntry ? Colors.primary : '#444', justifyContent: 'center', paddingHorizontal: 3 }}
              >
                <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff', alignSelf: watchVoiceEntry ? 'flex-end' : 'flex-start' }} />
              </Pressable>
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.text }}>Battery-saver mode</Text>
                <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textSecondary, marginTop: 2 }}>
                  Suppresses haptics + pauses the aim sensor stream.
                </Text>
              </View>
              <Pressable
                onPress={() => setWatchBatteryMode((v) => !v)}
                style={{ width: 44, height: 26, borderRadius: 13, backgroundColor: watchBatteryMode ? Colors.primary : '#444', justifyContent: 'center', paddingHorizontal: 3 }}
              >
                <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff', alignSelf: watchBatteryMode ? 'flex-end' : 'flex-start' }} />
              </Pressable>
            </View>

            {/* Auto-enable threshold — watch flips battery mode on automatically
                once the battery dips at or below this percentage (Task #420). */}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.text }}>Auto-enable below</Text>
                <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textSecondary, marginTop: 2 }}>
                  Watch turns on Battery-saver when its battery hits this level.
                </Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Pressable
                  onPress={() => setWatchBatteryAutoPct((v) => Math.max(10, v - 5))}
                  style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: '#444', alignItems: 'center', justifyContent: 'center' }}
                >
                  <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 16, color: '#fff' }}>−</Text>
                </Pressable>
                <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 14, color: Colors.text, minWidth: 36, textAlign: 'center' }}>
                  {watchBatteryAutoPct}%
                </Text>
                <Pressable
                  onPress={() => setWatchBatteryAutoPct((v) => Math.min(50, v + 5))}
                  style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: '#444', alignItems: 'center', justifyContent: 'center' }}
                >
                  <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 16, color: '#fff' }}>+</Text>
                </Pressable>
              </View>
            </View>

            {/* Auto shot detection sensitivity — controls how aggressively the
                engine fuses GPS stops + watch motion peaks at round end. */}
            <View style={{ paddingTop: 6, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)' }}>
              <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 13, color: Colors.text, marginTop: 6 }}>Auto-detect sensitivity</Text>
              <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 11, color: Colors.textSecondary, marginTop: 2, marginBottom: 8 }}>
                How aggressively to propose shots from your phone GPS + watch motion at round end.
              </Text>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {(["low", "medium", "high"] as const).map(level => (
                  <Pressable
                    key={level}
                    onPress={() => setAutoShotSensitivity(level)}
                    style={{
                      flex: 1,
                      paddingVertical: 8,
                      borderRadius: 8,
                      backgroundColor: autoShotSensitivity === level ? Colors.primary : '#444',
                      alignItems: 'center',
                    }}
                  >
                    <Text style={{
                      fontFamily: 'Inter_700Bold',
                      fontSize: 12,
                      color: autoShotSensitivity === level ? '#000' : '#fff',
                      textTransform: 'capitalize',
                    }}>
                      {level}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>

            <Pressable
              onPress={() => setWatchSettingsOpen(false)}
              style={{ marginTop: 4, paddingVertical: 12, borderRadius: 10, backgroundColor: Colors.primary, alignItems: 'center' }}
            >
              <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 14, color: '#000' }}>Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Per-hole shot review modal — wraps ShotReviewModal so its own
          SG-round useQuery (sharing the cache key with ScoringScreen's
          sgRound query above) refetches when the modal mutates, keeping
          the per-hole Strokes Gained card in sync after Add/Edit/Delete. */}
      {reviewShotsHole !== null && (
        <HoleShotReviewModal
          visible={reviewShotsHole !== null}
          onClose={() => setReviewShotsHole(null)}
          token={token ?? null}
          tournamentId={session.tournamentId}
          round={session.round}
          holeNumber={reviewShotsHole}
          onShotsRefreshed={() => { hydrateShotsFromServer().catch(() => {}); }}
        />
      )}
    </View>
  );
}

// ── Round Summary Screen ─────────────────────────────────────────────

function RoundSummaryScreen({
  session,
  holeResults,
  submissionCode,
  submissionTotal,
  submittingValidation,
  onSubmitForValidation,
  onShare,
  onDone,
  topPadding,
  bottomPadding,
  token,
}: {
  session: Session;
  holeResults: HoleResult[];
  submissionCode: string | null;
  submissionTotal: number | null;
  submittingValidation: boolean;
  onSubmitForValidation: () => void;
  onShare: () => void;
  onDone: () => void;
  topPadding: number;
  bottomPadding: number;
  token: string | null;
}) {
  const { data: sgRound } = useQuery<SGRoundResponse>({
    queryKey: ["portal-sg-round", session.tournamentId, session.round],
    queryFn: () => fetchPortal<SGRoundResponse>(
      `/sg/round?round=${session.round}&tournamentId=${session.tournamentId}`,
      token!,
    ),
    enabled: !!token,
    staleTime: 30 * 1000,
  });
  const totalStrokes = holeResults.reduce((s, h) => s + h.strokes, 0);
  const totalPar = holeResults.reduce((s, h) => s + h.par, 0);
  const totalToPar = totalStrokes - totalPar;

  const eagles = holeResults.filter(h => h.toPar <= -2).length;
  const birdies = holeResults.filter(h => h.toPar === -1).length;
  const pars = holeResults.filter(h => h.toPar === 0).length;
  const bogeys = holeResults.filter(h => h.toPar === 1).length;
  const doubles = holeResults.filter(h => h.toPar >= 2).length;

  const bestHole = holeResults.length > 0
    ? holeResults.reduce((best, h) => h.toPar < best.toPar ? h : best, holeResults[0])
    : null;

  const toParStr = totalToPar === 0 ? "E" : totalToPar > 0 ? `+${totalToPar}` : `${totalToPar}`;
  const toParColor = totalToPar < 0 ? Colors.birdie : totalToPar > 0 ? Colors.bogey : Colors.par;

  // Staggered fade-in
  const anim0 = useRef(new Animated.Value(0)).current;
  const anim1 = useRef(new Animated.Value(0)).current;
  const anim2 = useRef(new Animated.Value(0)).current;
  const anim3 = useRef(new Animated.Value(0)).current;
  const [animComplete, setAnimComplete] = useState(false);
  const [showCardModal, setShowCardModal] = useState(false);
  const [sharingCard, setSharingCard] = useState(false);
  const cardRef = useRef<View>(null);
  // Tap a per-hole SG dot to open the same Add/Edit/Delete shot review the
  // in-round ScoringScreen uses. The wrapper shares the
  // ["portal-sg-round", …] cache key with the summary's own sgRound query
  // above, so a successful Add Shot save refetches that key and the
  // per-hole SG dots / round-level totals on this screen update without
  // a manual reload.
  const [reviewShotsHole, setReviewShotsHole] = useState<number | null>(null);

  useEffect(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    const seq = [anim0, anim1, anim2, anim3].map((a) =>
      Animated.timing(a, { toValue: 1, duration: 350, useNativeDriver: true })
    );
    Animated.stagger(300, seq).start(() => setAnimComplete(true));
  }, []);

  const handleShareSummary = () => {
    setShowCardModal(true);
  };

  const handleCaptureAndShare = async () => {
    if (!cardRef.current) return;
    setSharingCard(true);
    try {
      const uri = await captureRef(cardRef, { format: "png", quality: 1, result: "tmpfile" });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(uri, { mimeType: "image/png", dialogTitle: "Share Round Summary" });
      } else {
        await Share.share({ message: `Round at ${session.tournamentName}: ${totalStrokes} (${toParStr})`, title: "Round Summary" });
      }
    } catch {
      Alert.alert("Share failed", "Could not share the round summary. Please try again.");
    } finally {
      setSharingCard(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: topPadding, paddingBottom: bottomPadding }]}>
      <ScrollView contentContainerStyle={styles.completeScreen}>
        {/* Trophy + title */}
        <Animated.View style={[styles.completeTrophy, { opacity: anim0, transform: [{ scale: anim0 }] }]}>
          <Ionicons name="trophy" size={48} color={Colors.secondary} />
        </Animated.View>
        <Animated.Text style={[styles.completeTitle, { opacity: anim0 }]}>Round Complete!</Animated.Text>
        <Animated.Text style={[styles.completeName, { opacity: anim0 }]}>{session.playerName}</Animated.Text>
        <Animated.Text style={[styles.completeTournament, { opacity: anim0 }]}>{session.tournamentName}</Animated.Text>

        {/* Summary card */}
        <Animated.View style={[styles.summaryCard, { opacity: anim1 }]}>
          {/* Strokes + to-par */}
          <View style={styles.summaryHero}>
            <Text style={styles.summaryStrokesLabel}>Total Strokes</Text>
            <Text style={styles.summaryStrokesValue}>{totalStrokes || "—"}</Text>
            <Text style={[styles.summaryToParValue, { color: toParColor }]}>{totalStrokes ? toParStr : "—"}</Text>
          </View>

          {/* Stat row */}
          <Animated.View style={[styles.statRow, { opacity: anim2 }]}>
            {eagles > 0 && (
              <View style={styles.statItem}>
                <Text style={[styles.statCount, { color: Colors.eagle }]}>{eagles}</Text>
                <Text style={[styles.statLabel, { color: Colors.eagle }]}>Eagle{eagles > 1 ? "s" : ""}</Text>
              </View>
            )}
            {birdies > 0 && (
              <View style={styles.statItem}>
                <Text style={[styles.statCount, { color: Colors.birdie }]}>{birdies}</Text>
                <Text style={[styles.statLabel, { color: Colors.birdie }]}>Birdie{birdies > 1 ? "s" : ""}</Text>
              </View>
            )}
            <View style={styles.statItem}>
              <Text style={[styles.statCount, { color: Colors.par }]}>{pars}</Text>
              <Text style={[styles.statLabel, { color: Colors.par }]}>Par{pars !== 1 ? "s" : ""}</Text>
            </View>
            {bogeys > 0 && (
              <View style={styles.statItem}>
                <Text style={[styles.statCount, { color: Colors.bogey }]}>{bogeys}</Text>
                <Text style={[styles.statLabel, { color: Colors.bogey }]}>Bogey{bogeys > 1 ? "s" : ""}</Text>
              </View>
            )}
            {doubles > 0 && (
              <View style={styles.statItem}>
                <Text style={[styles.statCount, { color: Colors.doubleOrWorse }]}>{doubles}</Text>
                <Text style={[styles.statLabel, { color: Colors.doubleOrWorse }]}>Dbl+</Text>
              </View>
            )}
          </Animated.View>

          {/* Best hole */}
          {bestHole && (
            <Animated.View style={[styles.bestHoleRow, { opacity: anim3 }]}>
              <Text style={styles.bestHoleLabel}>Best Hole</Text>
              <Text style={styles.bestHoleValue}>
                Hole {bestHole.holeNumber} · {bestHole.toPar === 0 ? "E" : bestHole.toPar > 0 ? `+${bestHole.toPar}` : `${bestHole.toPar}`}
              </Text>
            </Animated.View>
          )}

          {/* Per-hole Strokes Gained dots — mirrors the in-round hole-nav dots.
              Tapping a dot opens <HoleShotReviewModal> for that hole so the
              player can Add / Edit / Delete shots after the round. The dot row
              is extracted (Task #1085) so the press wiring can be tested. */}
          <RoundSummaryHoleDots
            holeResults={holeResults}
            sgRound={sgRound ?? null}
            onPressHole={setReviewShotsHole}
            opacity={anim3}
          />

          {/* Round-level Strokes Gained totals */}
          {sgRound?.totals && sgRound.shotsTracked > 0 && (
            <Animated.View style={[styles.sgTotalsStrip, { opacity: anim3, marginTop: 12, marginHorizontal: 0 }]}>
              <View style={styles.sgTotalsHeader}>
                <Feather name="trending-up" size={11} color={Colors.primary} />
                <Text style={styles.sgTotalsTitle}>STROKES GAINED · ROUND</Text>
                <Text style={styles.sgTotalsShots}>{sgRound.shotsTracked} shot{sgRound.shotsTracked === 1 ? "" : "s"}</Text>
              </View>
              <View style={styles.sgTotalsRow}>
                <SGStat label="Total" value={sgRound.totals.sgTotal} highlight />
                <SGStat label="OTT" value={sgRound.totals.sgOTT} />
                <SGStat label="App" value={sgRound.totals.sgApproach} />
                <SGStat label="ATG" value={sgRound.totals.sgATG} />
                <SGStat label="Putt" value={sgRound.totals.sgPutting} estimated={sgRound.totals.puttingEstimated} />
              </View>
              {sgRound.totals.puttingEstimated && (
                <Text style={styles.sgEstimateNote}>
                  ~ Some holes' Putt SG was estimated from your scorecard putt count.
                </Text>
              )}
            </Animated.View>
          )}
        </Animated.View>

        {/* Sponsor banner — sold inventory on the post-round summary screen */}
        {session.organizationId ? (
          <InlineAdBanner
            orgId={session.organizationId}
            slotKey="mobile_round_summary"
            tournamentId={session.tournamentId}
            height={56}
            style={{ marginTop: 12 }}
          />
        ) : null}

        {/* Share summary — appears with last animation */}
        <Animated.View style={{ opacity: anim3, width: "100%" }}>
          <Pressable onPress={handleShareSummary} style={[styles.shareBtn, { marginTop: 8 }]}>
            <Feather name="share-2" size={16} color={Colors.secondary} />
            <Text style={[styles.shareBtnText, { color: Colors.secondary }]}>Share Round Summary</Text>
          </Pressable>
        </Animated.View>

        {/* Marker Validation + Scorecard Share + Done — revealed after animation completes */}
        {animComplete && (
          <>
            {submissionCode ? (
              <View style={[styles.codeBox, { backgroundColor: Colors.primary + '15', borderColor: Colors.primary + '50' }]}>
                <Ionicons name="shield-checkmark" size={28} color={Colors.primary} />
                <Text style={[styles.codeLabel, { color: Colors.primary, marginTop: 8 }]}>Submitted for Validation</Text>
                {submissionTotal !== null && <Text style={styles.codeTotal}>Total: {submissionTotal} strokes</Text>}
                <Text style={styles.codeInstructions}>Your marker can log into the app and validate your round in the Marker section.</Text>
              </View>
            ) : (
              <Pressable
                onPress={onSubmitForValidation}
                disabled={submittingValidation}
                style={[styles.validateBtn, submittingValidation && { opacity: 0.6 }]}
              >
                {submittingValidation
                  ? <LoadingSpinner size="small" color={Colors.primary} />
                  : <><Ionicons name="shield-checkmark-outline" size={18} color={Colors.primary} style={{ marginRight: 8 }} /><Text style={styles.validateBtnText}>Submit for Marker Validation</Text></>
                }
              </Pressable>
            )}

            <Pressable onPress={onShare} style={styles.shareBtn}>
              <Feather name="share-2" size={16} color={Colors.textSecondary} />
              <Text style={styles.shareBtnText}>Share Scorecard</Text>
            </Pressable>

            <Pressable onPress={onDone} style={styles.doneBtn}>
              <Text style={styles.doneBtnText}>Done</Text>
            </Pressable>
          </>
        )}
      </ScrollView>

      {/* ── Share Card Modal ─────────────────────────────────────── */}
      <Modal
        visible={showCardModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowCardModal(false)}
      >
        <View style={styles.cardModalBg}>
          <View style={styles.cardModalHeader}>
            <Text style={styles.cardModalTitle}>Round Summary Card</Text>
            <Pressable onPress={() => setShowCardModal(false)} style={styles.cardModalClose}>
              <Ionicons name="close" size={22} color="#9CA3AF" />
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.cardModalScroll} showsVerticalScrollIndicator={false}>
            <Text style={styles.cardModalHint}>Preview your card and tap Share to send it.</Text>
            {/* Captured view */}
            <View collapsable={false} ref={cardRef} style={styles.cardCapture}>
              <RoundSummaryCard
                tournamentName={session.tournamentName}
                playerName={session.playerName}
                orgName={session.orgName}
                orgColor={session.orgColor ?? undefined}
                round={session.round}
                gross={totalStrokes}
                toPar={totalToPar}
                holesPlayed={holeResults.length}
                eagles={eagles}
                birdies={birdies}
                pars={pars}
                bogeys={bogeys}
                doubles={doubles}
                holeResults={holeResults.map(h => ({
                  holeNumber: h.holeNumber,
                  par: h.par,
                  strokes: h.strokes,
                  toPar: h.toPar,
                }))}
                sgTotals={sgRound?.totals ?? null}
                sgShotsTracked={sgRound?.shotsTracked}
              />
            </View>
          </ScrollView>

          <View style={styles.cardModalActions}>
            <Pressable
              onPress={handleCaptureAndShare}
              disabled={sharingCard}
              style={[styles.cardShareBtn, sharingCard && { opacity: 0.6 }]}
            >
              {sharingCard ? (
                <LoadingSpinner size="small" color="#0D1117" />
              ) : (
                <>
                  <Feather name="share-2" size={18} color="#0D1117" />
                  <Text style={styles.cardShareBtnText}>Share Card</Text>
                </>
              )}
            </Pressable>
            <Pressable onPress={() => setShowCardModal(false)} style={styles.cardCancelBtn}>
              <Text style={styles.cardCancelBtnText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Per-hole shot review on the post-round summary — same wrapper the
          in-round ScoringScreen uses so the ["portal-sg-round", …] cache
          key shared with this screen's sgRound query refetches after any
          Add / Edit / Delete, and the per-hole SG dots + round totals
          rendered above pick up the new numbers. */}
      {reviewShotsHole !== null && (
        <HoleShotReviewModal
          visible={reviewShotsHole !== null}
          onClose={() => setReviewShotsHole(null)}
          token={token}
          tournamentId={session.tournamentId}
          round={session.round}
          holeNumber={reviewShotsHole}
        />
      )}
    </View>
  );
}

// ── Main Score Tab ──────────────────────────────────────────────────

export default function ScoreScreen() {
  const insets = useSafeAreaInsets();
  const isWeb = Platform.OS === "web";
  const topPadding = isWeb ? 67 : insets.top;
  const bottomPadding = isWeb ? 34 : insets.bottom;

  // Auth — used to auto-resolve the player record when logged in
  const { token, isAuthenticated, user } = useAuth();
  const isAdmin = !!user && ["org_admin", "tournament_director", "committee_member", "super_admin", "volunteer"].includes(user.role);
  const router = useRouter();

  // ── Play Hub data ─────────────────────────────────────────────────────
  // Fetch player stats (includes handicap trend) for the hub header card.
  interface MyStats { tournamentsPlayed: number; totalScores: number; averageStrokes: number | null; bestRound: number | null; hcpTrend?: { handicapIndex: number; recordedAt: string | null }[] }
  const { data: myStats } = useQuery({
    queryKey: ["my-stats-play", token],
    queryFn: () => fetchPortal<MyStats>("/my-stats", token!),
    enabled: !!token,
    staleTime: 120_000,
  });
  const currentHcp = myStats?.hcpTrend?.length
    ? myStats.hcpTrend[myStats.hcpTrend.length - 1].handicapIndex
    : null;

  // Recent rounds — last 5 tournaments the player competed in
  interface RecentRound { tournamentId: number; tournamentName: string; tournamentStatus: string; handicapIndex: string | null; startDate?: string | null; format?: string | null }
  const { data: recentRounds } = useQuery({
    queryKey: ["my-recent-rounds-play", token],
    queryFn: () => fetchPortal<RecentRound[]>("/my-tournaments", token!),
    enabled: !!token,
    staleTime: 60_000,
    select: (rows) => rows
      .filter((r) => r.tournamentStatus === "completed" || r.tournamentStatus === "active")
      .slice(-5)
      .reverse(),
  });

  const [step, setStep] = useState<Step>("tournament");
  const [showQRScanner, setShowQRScanner] = useState(false);
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [player, setPlayer] = useState<Player | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [roundComplete, setRoundComplete] = useState(false);
  const [roundHoleResults, setRoundHoleResults] = useState<HoleResult[]>([]);
  const [submissionCode, setSubmissionCode] = useState<string | null>(null);
  const [submissionTotal, setSubmissionTotal] = useState<number | null>(null);
  const [submittingValidation, setSubmittingValidation] = useState(false);
  const [validateMode, setValidateMode] = useState(false);
  const [validateActionLoading, setValidateActionLoading] = useState(false);
  const [validateDone, setValidateDone] = useState<string | null>(null);
  // Marker email/password auth state
  const [markerAuthMode, setMarkerAuthMode] = useState<'login' | 'list'>('login');
  const [markerEmail, setMarkerEmail] = useState('');
  const [markerPassword, setMarkerPassword] = useState('');
  const [markerLoginLoading, setMarkerLoginLoading] = useState(false);
  const [markerLoginError, setMarkerLoginError] = useState<string | null>(null);
  const [markerToken, setMarkerToken] = useState<string | null>(null);
  const [markerName, setMarkerName] = useState<string | null>(null);
  const [markerPending, setMarkerPending] = useState<Array<{ submissionId: number; playerName: string; tournamentName: string; round: number; totalStrokes: number; scores: { hole: number; strokes: number }[]; status: string }>>([]);
  const [markerPendingLoading, setMarkerPendingLoading] = useState(false);

  // Identity-bound scoring: auto-resolve when authenticated
  const [resolvingPlayer, setResolvingPlayer] = useState(false);
  const [notRegistered, setNotRegistered] = useState(false);

  // Pre-round marker selection state
  const [markerCandidates, setMarkerCandidates] = useState<MarkerCandidate[]>([]);
  const [loadingMarkers, setLoadingMarkers] = useState(false);
  const [selectedMarkerPlayerId, setSelectedMarkerPlayerId] = useState<number | null>(null);
  const [markerFreeText, setMarkerFreeText] = useState("");

  // Restore session
  useEffect(() => {
    AsyncStorage.getItem(SESSION_KEY).then((raw) => {
      if (!raw) return;
      try {
        const saved: Session = JSON.parse(raw);
        setSession(saved);
        setStep("scoring");
      } catch {}
    });
  }, []);

  const startSession = useCallback((t: Tournament, p: Player, mPlayerId?: number | null, mName?: string | null) => {
    const s: Session = {
      tournamentId: t.id,
      tournamentName: t.name,
      playerId: p.id,
      playerName: `${p.firstName} ${p.lastName}`,
      round: 1,
      organizationId: t.organizationId,
      orgName: t.organizationName,
      orgColor: t.organizationPrimaryColor ?? null,
      handicapIndex: p.handicapIndex,
      markerPlayerId: mPlayerId ?? null,
      markerName: mName ?? null,
    };
    AsyncStorage.setItem(SESSION_KEY, JSON.stringify(s));
    setSession(s);
    setStep("scoring");
    // WHS Rule 7.1: persist marker assignment server-side before scoring begins
    if (token && mPlayerId) {
      postPortal(`/tournaments/${t.id}/pre-round-marker`, token, { markerPlayerId: mPlayerId, round: 1 })
        .catch(() => { /* non-blocking — marker also sent again at submit time */ });
    }
  }, [token]);

  const proceedToMarker = useCallback((t: Tournament, p: Player) => {
    setTournament(t);
    setPlayer(p);
    setSelectedMarkerPlayerId(null);
    setMarkerFreeText("");
    setMarkerCandidates([]);
    setStep("marker");
    if (token) {
      setLoadingMarkers(true);
      fetchPortal<{ allFlightmates: MarkerCandidate[] }>(`/tournaments/${t.id}/my-marker`, token)
        .then(res => setMarkerCandidates(res.allFlightmates ?? []))
        .catch(() => setMarkerCandidates([]))
        .finally(() => setLoadingMarkers(false));
    }
  }, [token]);

  const clearSession = useCallback(() => {
    AsyncStorage.removeItem(SESSION_KEY);
    setSession(null);
    setTournament(null);
    setPlayer(null);
    setStep("tournament");
    setRoundComplete(false);
    setSubmissionCode(null);
    setSubmissionTotal(null);
    setNotRegistered(false);
    setResolvingPlayer(false);
  }, []);

  const handleSubmitForValidation = useCallback(async () => {
    if (!session) return;
    setSubmittingValidation(true);
    try {
      const result = await postPublic<{ submissionId: number; totalStrokes: number }>(
        `/tournaments/${session.tournamentId}/players/${session.playerId}/submit`,
        {
          round: session.round,
          ...(session.markerPlayerId ? { markerPlayerId: session.markerPlayerId } : {}),
          ...(session.markerName && !session.markerPlayerId ? { markerName: session.markerName } : {}),
        },
        token ?? undefined
      );
      // WHS Rule 7.1: player must formally sign their card (pending → submitted)
      // This triggers the push notification to the designated marker.
      if (token && result.submissionId) {
        try {
          await postPortal(`/submissions/${result.submissionId}/sign`, token, {});
        } catch {
          // Sign failure is non-fatal — the submission is still recorded;
          // marker can still be notified via other means.
        }
      }
      setSubmissionCode('submitted'); // flag: use presence to show confirmation view
      setSubmissionTotal(result.totalStrokes);
    } catch {
      // ignore
    } finally {
      setSubmittingValidation(false);
    }
  }, [session, token]);


  const handleMarkerLogin = useCallback(async () => {
    if (!markerEmail || !markerPassword) return;
    setMarkerLoginLoading(true);
    setMarkerLoginError(null);
    try {
      const resp = await fetch(`${BASE_URL}/api/auth/player-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-client-type': 'mobile' },
        body: JSON.stringify({ email: markerEmail, password: markerPassword }),
      });
      const data = await resp.json() as { token?: string; user?: { displayName?: string; email?: string }; error?: string };
      if (!resp.ok || !data.token) {
        setMarkerLoginError(data.error ?? 'Invalid email or password');
        return;
      }
      setMarkerToken(data.token);
      setMarkerName(data.user?.displayName ?? data.user?.email ?? markerEmail);
      setMarkerAuthMode('list');
      // Fetch pending submissions
      setMarkerPendingLoading(true);
      try {
        const subResp = await fetch(`${BASE_URL}/api/portal/pending-submissions`, {
          headers: { 'Authorization': `Bearer ${data.token}` },
        });
        const subs = await subResp.json() as Array<{ submissionId: number; playerName: string; tournamentName: string; round: number; totalStrokes: number; scores: { hole: number; strokes: number }[]; status: string }>;
        setMarkerPending(Array.isArray(subs) ? subs : []);
      } catch { setMarkerPending([]); } finally {
        setMarkerPendingLoading(false);
      }
    } catch {
      setMarkerLoginError('Could not connect. Please try again.');
    } finally {
      setMarkerLoginLoading(false);
    }
  }, [markerEmail, markerPassword]);

  const handleMarkerApprove = useCallback(async (submissionId: number) => {
    if (!markerToken) return;
    setValidateActionLoading(true);
    try {
      const response = await fetch(`${BASE_URL}/api/portal/submissions/${submissionId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${markerToken}` },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        Alert.alert('Approval Failed', data.error ?? `Server error (${response.status})`);
        return;
      }
      setMarkerPending(prev => prev.filter(s => s.submissionId !== submissionId));
      setValidateDone('approved');
    } catch (err) {
      Alert.alert('Network Error', 'Unable to reach server. Please check your connection and try again.');
    } finally {
      setValidateActionLoading(false);
    }
  }, [markerToken]);

  const [rejectReasonModalId, setRejectReasonModalId] = useState<number | null>(null);
  const [rejectReasonText, setRejectReasonText] = useState('');

  const submitMarkerReject = useCallback(async (submissionId: number, reason: string) => {
    if (!markerToken) return;
    setValidateActionLoading(true);
    try {
      const response = await fetch(`${BASE_URL}/api/portal/submissions/${submissionId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${markerToken}` },
        body: JSON.stringify({ reason: reason.trim() || 'Marker did not agree with the score' }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        Alert.alert('Rejection Failed', data.error ?? `Server error (${response.status})`);
        return;
      }
      setMarkerPending(prev => prev.filter(s => s.submissionId !== submissionId));
      setValidateDone('rejected');
    } catch (err) {
      Alert.alert('Network Error', 'Unable to reach server. Please check your connection and try again.');
    } finally {
      setValidateActionLoading(false);
    }
  }, [markerToken]);

  const handleMarkerReject = useCallback((submissionId: number) => {
    setRejectReasonText('');
    setRejectReasonModalId(submissionId);
  }, []);

  const handleTournamentSelect = useCallback(async (t: Tournament) => {
    setTournament(t);
    setNotRegistered(false);

    // When the user is logged in, auto-resolve their player record so they skip the picker
    if (isAuthenticated && token) {
      setResolvingPlayer(true);
      setStep("player"); // show player step (will render resolving spinner)
      try {
        type MyTournamentRow = {
          playerId: number;
          tournamentId: number;
          firstName: string;
          lastName: string;
          handicapIndex: number | null;
          teeBox: string | null;
        };
        const rows = await fetchPortal<MyTournamentRow[]>("/my-tournaments", token);
        const match = rows.find((r) => r.tournamentId === t.id);
        if (match) {
          const autoPlayer: Player = {
            id: match.playerId,
            firstName: match.firstName,
            lastName: match.lastName,
            handicapIndex: match.handicapIndex ?? 0,
            flight: null,
            teeBox: match.teeBox ?? "white",
          };
          setPlayer(autoPlayer);
          proceedToMarker(t, autoPlayer);
          return;
        } else {
          setNotRegistered(true);
        }
      } catch {
        // Fall through to manual picker on network error
      } finally {
        setResolvingPlayer(false);
      }
    } else {
      setStep("player");
    }
  }, [isAuthenticated, token, proceedToMarker]);

  const handlePlayerSelect = useCallback((p: Player) => {
    if (!tournament) return;
    setPlayer(p);
    proceedToMarker(tournament, p);
  }, [tournament, proceedToMarker]);

  const handleFinish = useCallback((holeResults: HoleResult[]) => {
    setRoundHoleResults(holeResults);
    setRoundComplete(true);
    // Refresh Apple Health (sleep / HRV / RHR / steps) into the wellness store
    // after every round on iOS — no-op on Android. Fire-and-forget so a slow
    // HealthKit query never blocks the round-complete screen.
    if (token && isAppleHealthSupported()) {
      syncAppleHealthLast7Days(token).catch(() => {});
    }
    // Android equivalent — Google's Health Connect SDK feeds the same
    // wellness store with `source: "google_fit"`. No-op on iOS / web.
    if (token && isHealthConnectSupported()) {
      syncHealthConnectLast7Days(token).catch(() => {});
    }
  }, [token]);

  const handleShareScorecard = useCallback(async () => {
    if (!session) return;
    try {
      const text = `KHARAGOLF Scorecard\n${session.playerName}\n${session.tournamentName}\nTotal: ${submissionTotal ?? "N/A"} strokes\nRound submitted ✓`;
      if (Platform.OS !== "web") {
        await Share.share({ message: text, title: "Scorecard" });
      } else {
        Alert.alert("Scorecard", text);
      }
    } catch {
      Alert.alert("Could not share scorecard");
    }
  }, [session, submissionTotal]);

  if (roundComplete && session) {
    return (
      <RoundSummaryScreen
        session={session}
        holeResults={roundHoleResults}
        submissionCode={submissionCode}
        submissionTotal={submissionTotal}
        submittingValidation={submittingValidation}
        onSubmitForValidation={handleSubmitForValidation}
        onShare={handleShareScorecard}
        onDone={clearSession}
        topPadding={topPadding}
        bottomPadding={bottomPadding}
        token={token ?? null}
      />
    );
  }

  return (
    <View style={[styles.container, { paddingTop: topPadding }]}>
      {/* Header (shown for non-scoring steps) */}
      {step !== "scoring" && (
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>KHARA<Text style={{ color: '#C9A84C' }}>GOLF</Text></Text>
            <Text style={styles.headerTitle}>Score Entry</Text>
          </View>
          <View style={styles.logoContainer}>
            <Image source={require('../../assets/logo.png')} style={styles.logoImage} resizeMode="contain" />
          </View>
        </View>
      )}

      {/* Step content */}
      <View style={[styles.stepContent, { paddingBottom: isWeb ? 34 + 84 : insets.bottom + 100 }]}>
        {step === "tournament" && !validateMode && (
          <>
            {/* ── Play Hub ─────────────────────────────────────────── */}
            <View style={{ paddingHorizontal: 16, paddingTop: 16, gap: 12 }}>
              {/* Handicap Index card */}
              {isAuthenticated && (
                <View style={{
                  backgroundColor: '#1a2c22', borderRadius: 14, borderWidth: 1, borderColor: '#243b2e',
                  padding: 16, flexDirection: 'row', alignItems: 'center', gap: 16,
                }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, color: '#4b7060', fontFamily: 'Inter_500Medium', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 }}>Handicap Index</Text>
                    <Text style={{ fontSize: 36, color: '#C9A84C', fontFamily: 'Inter_700Bold', lineHeight: 40 }}>
                      {currentHcp != null ? currentHcp.toFixed(1) : '—'}
                    </Text>
                    <Text style={{ fontSize: 12, color: '#4b7060', fontFamily: 'Inter_400Regular', marginTop: 2 }}>
                      {myStats?.tournamentsPlayed ?? 0} events · {myStats?.totalScores ?? 0} holes scored
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => router.push('/handicap-profile')}
                    style={{ backgroundColor: '#C9A84C20', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: '#C9A84C40' }}
                  >
                    <Text style={{ color: '#C9A84C', fontFamily: 'Inter_600SemiBold', fontSize: 12 }}>History</Text>
                  </Pressable>
                </View>
              )}

              {/* Active session resume */}
              {session && (
                <Pressable
                  style={{ backgroundColor: Colors.primary + '15', borderRadius: 12, borderWidth: 1, borderColor: Colors.primary + '40', padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }}
                  onPress={() => setStep("scoring")}
                >
                  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.primary }} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, color: Colors.primary, fontFamily: 'Inter_600SemiBold' }}>Resume Active Round</Text>
                    <Text style={{ fontSize: 12, color: Colors.textSecondary, fontFamily: 'Inter_400Regular' }}>{session.playerName} · {session.tournamentName}</Text>
                  </View>
                  <Feather name="chevron-right" size={16} color={Colors.primary} />
                </Pressable>
              )}

              {/* Start General Play */}
              <Pressable
                style={{ backgroundColor: '#C9A84C', borderRadius: 14, padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 }}
                onPress={() => router.push('/general-play')}
              >
                <Ionicons name="golf" size={20} color="#000" />
                <Text style={{ color: '#000', fontFamily: 'Inter_700Bold', fontSize: 16 }}>Start General Play Round</Text>
              </Pressable>

              {/* Scorer Station */}
              {isAuthenticated && token && (
                <Pressable onPress={() => router.push('/scorer-station')} style={[styles.markerEntryBtn, { borderColor: '#C9A84C40', backgroundColor: '#C9A84C10' }]}>
                  <Feather name="edit-3" size={18} color="#C9A84C" />
                  <Text style={[styles.markerEntryBtnText, { color: '#C9A84C' }]}>Open Scorer Station</Text>
                </Pressable>
              )}

              {/* Marker Inbox */}
              {isAuthenticated && token && (
                <Pressable onPress={() => router.push('/(tabs)/marker')} style={[styles.markerEntryBtn, { borderColor: '#a855f740', backgroundColor: '#a855f710' }]}>
                  <Ionicons name="shield-checkmark-outline" size={18} color="#a855f7" />
                  <Text style={[styles.markerEntryBtnText, { color: '#a855f7' }]}>Marker Inbox</Text>
                </Pressable>
              )}

              {/* Recent Rounds */}
              {isAuthenticated && recentRounds && recentRounds.length > 0 && (
                <View style={{ gap: 8 }}>
                  <Text style={{ fontSize: 11, color: Colors.textSecondary, letterSpacing: 1.8, fontFamily: 'Inter_600SemiBold', textTransform: 'uppercase', marginBottom: 2 }}>RECENT ROUNDS</Text>
                  {recentRounds.map((r) => (
                    <Pressable
                      key={`${r.tournamentId}`}
                      onPress={() => router.push({ pathname: '/(tabs)/leaderboard', params: { tournamentId: String(r.tournamentId) } })}
                      style={{ backgroundColor: '#1a2c22', borderRadius: 12, borderWidth: 1, borderColor: '#243b2e', padding: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }}
                    >
                      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: r.tournamentStatus === 'active' ? Colors.primary + '20' : '#243b2e', alignItems: 'center', justifyContent: 'center' }}>
                        <Ionicons name="golf" size={18} color={r.tournamentStatus === 'active' ? Colors.primary : '#4b7060'} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 13, color: '#e8f5ee', fontFamily: 'Inter_600SemiBold' }} numberOfLines={1}>{r.tournamentName}</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 }}>
                          <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, backgroundColor: r.tournamentStatus === 'active' ? Colors.primary + '22' : '#243b2e' }}>
                            <Text style={{ fontSize: 10, color: r.tournamentStatus === 'active' ? Colors.primary : '#94b4a4', fontFamily: 'Inter_500Medium', textTransform: 'uppercase', letterSpacing: 0.5 }}>{r.tournamentStatus}</Text>
                          </View>
                          {r.handicapIndex != null && (
                            <Text style={{ fontSize: 11, color: '#4b7060', fontFamily: 'Inter_400Regular' }}>HCP {Number(r.handicapIndex).toFixed(1)}</Text>
                          )}
                        </View>
                      </View>
                      <Feather name="chevron-right" size={16} color="#4b7060" />
                    </Pressable>
                  ))}
                </View>
              )}
            </View>

            {/* ── Section: Score for a tournament ─────────────────── */}
            <View style={{ paddingHorizontal: 16, paddingTop: 20, paddingBottom: 4 }}>
              <Text style={{ fontSize: 11, color: Colors.textSecondary, letterSpacing: 1.8, fontFamily: 'Inter_600SemiBold', textTransform: 'uppercase' }}>SCORE A TOURNAMENT</Text>
            </View>

            <TournamentSelector onSelect={handleTournamentSelect} />
            {/* Admin: QR Check-In Scanner */}
            {isAdmin && isAuthenticated && token && (
              <Pressable onPress={() => setShowQRScanner(true)} style={[styles.markerEntryBtn, { borderColor: Colors.primary + "40", backgroundColor: Colors.primary + "10" }]}>
                <Ionicons name="qr-code-outline" size={18} color={Colors.primary} />
                <Text style={[styles.markerEntryBtnText, { color: Colors.primary }]}>Scan QR Check-In</Text>
              </Pressable>
            )}
            {/* Validate a Round button */}
            <Pressable onPress={() => { setValidateMode(true); setValidateDone(null);   }} style={styles.markerEntryBtn}>
              <Ionicons name="shield-checkmark-outline" size={18} color={Colors.textSecondary} />
              <Text style={styles.markerEntryBtnText}>Validate a Round (Marker)</Text>
            </Pressable>
          </>
        )}
        {step === "tournament" && validateMode && (
          <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
            <Pressable onPress={() => { setValidateMode(false); setMarkerAuthMode('login'); setMarkerToken(null); setMarkerName(null); setMarkerPending([]); setValidateDone(null); }} style={styles.backBtn}>
              <Feather name="arrow-left" size={20} color={Colors.textSecondary} />
            </Pressable>
            <Text style={styles.stepLabel}>MARKER VALIDATION</Text>

            {/* Success / Rejection banners */}
            {validateDone === 'approved' && (
              <View style={[styles.codeBox, { backgroundColor: Colors.primary + '20', borderColor: Colors.primary }]}>
                <Ionicons name="checkmark-circle" size={32} color={Colors.primary} />
                <Text style={[styles.codeLabel, { color: Colors.primary, marginTop: 8 }]}>Round Approved!</Text>
                <Text style={styles.codeInstructions}>The round has been verified and approved.</Text>
                <Pressable onPress={() => { setValidateDone(null);  }} style={[styles.doneBtn, { marginTop: 12 }]}>
                  <Text style={styles.doneBtnText}>Validate Another</Text>
                </Pressable>
              </View>
            )}
            {validateDone === 'rejected' && (
              <View style={[styles.codeBox, { backgroundColor: '#ff444420', borderColor: '#ff4444' }]}>
                <Ionicons name="close-circle" size={32} color="#ff4444" />
                <Text style={[styles.codeLabel, { color: '#ff4444', marginTop: 8 }]}>Round Rejected</Text>
                <Text style={styles.codeInstructions}>The round has been marked as rejected.</Text>
                <Pressable onPress={() => { setValidateDone(null);  }} style={[styles.doneBtn, { marginTop: 12 }]}>
                  <Text style={styles.doneBtnText}>Validate Another</Text>
                </Pressable>
              </View>
            )}

            {!validateDone && (
              <>
                {/* Email/Password Login */}
                {!markerToken && (
                  <View style={{ gap: 12 }}>
                    <Text style={styles.codeInstructions}>Log in with your player portal account to see and validate pending scores for your tournament.</Text>
                    <TextInput
                      style={styles.codeInput}
                      value={markerEmail}
                      onChangeText={setMarkerEmail}
                      placeholder="Email"
                      placeholderTextColor={Colors.muted}
                      keyboardType="email-address"
                      autoCapitalize="none"
                    />
                    <TextInput
                      style={styles.codeInput}
                      value={markerPassword}
                      onChangeText={setMarkerPassword}
                      placeholder="Password"
                      placeholderTextColor={Colors.muted}
                      secureTextEntry
                    />
                    {markerLoginError && <Text style={{ color: '#ff4444', fontSize: 13, fontFamily: 'Inter_400Regular' }}>{markerLoginError}</Text>}
                    <Pressable
                      onPress={handleMarkerLogin}
                      disabled={markerLoginLoading || !markerEmail || !markerPassword}
                      style={[styles.approveBtn, { opacity: markerLoginLoading || !markerEmail || !markerPassword ? 0.5 : 1 }]}
                    >
                      {markerLoginLoading ? <LoadingSpinner size="small" color="#000" /> : <><Ionicons name="shield-checkmark-outline" size={18} color="#000" style={{ marginRight: 6 }} /><Text style={styles.approveBtnText}>Log In & View Pending Scores</Text></>}
                    </Pressable>
                  </View>
                )}

                {/* Pending submissions list for logged-in marker */}
                {markerToken && (
                  <View style={{ gap: 12 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 14, color: Colors.text }}>Signed in as marker: <Text style={{ color: Colors.primary }}>{markerName}</Text></Text>
                      <Pressable onPress={() => { setMarkerToken(null); setMarkerName(null); setMarkerPending([]); setMarkerAuthMode('login'); setMarkerEmail(''); setMarkerPassword(''); }}>
                        <Text style={{ fontSize: 12, color: Colors.textSecondary, fontFamily: 'Inter_400Regular' }}>Sign out</Text>
                      </Pressable>
                    </View>
                    {markerPendingLoading && <LoadingSpinner color={Colors.primary} />}
                    {!markerPendingLoading && markerPending.length === 0 && (
                      <View style={[styles.codeBox, { alignItems: 'center' }]}>
                        <Ionicons name="checkmark-circle-outline" size={28} color={Colors.textSecondary} />
                        <Text style={[styles.codeInstructions, { marginTop: 8 }]}>No pending submissions in your tournaments. All scores are validated.</Text>
                      </View>
                    )}
                    {!markerPendingLoading && markerPending.map(sub => (
                      <View key={sub.submissionId} style={styles.validateCard}>
                        <Text style={styles.validateCardName}>{sub.playerName}</Text>
                        <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 12, color: Colors.textSecondary, marginBottom: 4 }}>{sub.tournamentName} · Round {sub.round}</Text>
                        <Text style={styles.validateCardTotal}>Total Strokes: {sub.totalStrokes}</Text>
                        <View style={styles.validateScoreGrid}>
                          {sub.scores.map(s => (
                            <View key={s.hole} style={styles.validateScoreCell}>
                              <Text style={styles.validateScoreHole}>H{s.hole}</Text>
                              <Text style={styles.validateScoreVal}>{s.strokes}</Text>
                            </View>
                          ))}
                        </View>
                        <View style={styles.validateActions}>
                          <Pressable onPress={() => handleMarkerReject(sub.submissionId)} disabled={validateActionLoading} style={[styles.rejectBtn, validateActionLoading && { opacity: 0.5 }]}>
                            <Ionicons name="close-circle-outline" size={18} color="#ff4444" />
                            <Text style={styles.rejectBtnText}>Reject</Text>
                          </Pressable>
                          <Pressable onPress={() => handleMarkerApprove(sub.submissionId)} disabled={validateActionLoading} style={[styles.approveBtn, validateActionLoading && { opacity: 0.5 }]}>
                            {validateActionLoading ? <LoadingSpinner size="small" color="#000" /> : <><Ionicons name="checkmark-circle-outline" size={18} color="#000" /><Text style={styles.approveBtnText}>Approve</Text></>}
                          </Pressable>
                        </View>
                      </View>
                    ))}
                  </View>
                )}

              </>
            )}
          </ScrollView>
        )}
        {step === "player" && tournament && (
          resolvingPlayer ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16 }}>
              <LoadingSpinner size="large" color={Colors.primary} />
              <Text style={{ color: Colors.textSecondary, fontSize: 15 }}>Looking up your registration…</Text>
            </View>
          ) : notRegistered ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 16 }}>
              <Ionicons name="alert-circle-outline" size={48} color={Colors.textSecondary} />
              <Text style={{ color: Colors.text, fontSize: 17, fontWeight: "600", textAlign: "center" }}>Not Registered</Text>
              <Text style={{ color: Colors.textSecondary, fontSize: 14, textAlign: "center" }}>
                Your account is not registered for {tournament.name}. Contact your tournament organiser to be added.
              </Text>
              <Pressable onPress={() => setStep("tournament")} style={{ marginTop: 8, paddingVertical: 12, paddingHorizontal: 32, borderRadius: 8, backgroundColor: Colors.primary }}>
                <Text style={{ color: "#fff", fontWeight: "600" }}>Back to Tournaments</Text>
              </Pressable>
            </View>
          ) : (
            <PlayerSelector
              tournamentId={tournament.id}
              onSelect={handlePlayerSelect}
              onBack={() => setStep("tournament")}
            />
          )
        )}
        {step === "marker" && tournament && player && (
          <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
            <Pressable onPress={() => setStep(isAuthenticated ? "tournament" : "player")} style={styles.backBtn}>
              <Feather name="arrow-left" size={20} color={Colors.textSecondary} />
            </Pressable>
            <Text style={styles.stepLabel}>SELECT MARKER</Text>
            <Text style={{ fontSize: 13, color: Colors.textSecondary, fontFamily: 'Inter_400Regular', marginBottom: 4 }}>
              WHS Rule 7.1 requires you to designate a marker before play begins. Select a playing partner or enter a name manually.
            </Text>

            {loadingMarkers ? (
              <LoadingSpinner color={Colors.primary} style={{ marginVertical: 16 }} />
            ) : markerCandidates.length > 0 ? (
              <>
                <Text style={{ fontSize: 11, color: Colors.textSecondary, letterSpacing: 1.5, fontFamily: 'Inter_600SemiBold', textTransform: 'uppercase', marginBottom: 4 }}>PLAYING PARTNERS</Text>
                {markerCandidates.map(c => (
                  <Pressable
                    key={c.playerId}
                    onPress={() => { setSelectedMarkerPlayerId(c.playerId); setMarkerFreeText(""); }}
                    style={{
                      backgroundColor: selectedMarkerPlayerId === c.playerId ? Colors.primary + '20' : Colors.surface,
                      borderWidth: 1,
                      borderColor: selectedMarkerPlayerId === c.playerId ? Colors.primary : Colors.border,
                      borderRadius: 12, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12,
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: Colors.text, fontFamily: 'Inter_600SemiBold', fontSize: 15 }}>{c.name}</Text>
                      {c.previousPlayCount > 0 && (
                        <Text style={{ color: Colors.textSecondary, fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 }}>
                          Played together {c.previousPlayCount}× before
                        </Text>
                      )}
                    </View>
                    {selectedMarkerPlayerId === c.playerId && (
                      <Feather name="check-circle" size={20} color={Colors.primary} />
                    )}
                  </Pressable>
                ))}
                <Text style={{ fontSize: 11, color: Colors.textSecondary, letterSpacing: 1.5, fontFamily: 'Inter_600SemiBold', textTransform: 'uppercase', marginTop: 8, marginBottom: 4 }}>OR ENTER NAME</Text>
              </>
            ) : null}

            <TextInput
              style={[styles.codeInput, { fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.text }]}
              value={markerFreeText}
              onChangeText={text => { setMarkerFreeText(text); if (text) setSelectedMarkerPlayerId(null); }}
              placeholder="Marker's full name (optional)"
              placeholderTextColor={Colors.muted}
              autoCapitalize="words"
            />

            <Pressable
              onPress={() => {
                const mName = markerFreeText.trim() || markerCandidates.find(c => c.playerId === selectedMarkerPlayerId)?.name || null;
                startSession(tournament!, player!, selectedMarkerPlayerId, mName);
              }}
              style={[styles.approveBtn, { marginTop: 8 }]}
            >
              <Text style={styles.approveBtnText}>
                {selectedMarkerPlayerId || markerFreeText.trim()
                  ? "Confirm Marker & Start Round"
                  : "Skip & Start Round (no pre-assigned marker)"}
              </Text>
            </Pressable>
          </ScrollView>
        )}

        {step === "scoring" && session && (
          <ScoringScreen
            session={session}
            onFinish={handleFinish}
            onBack={clearSession}
          />
        )}
      </View>
      {/* QR Check-In Scanner Modal */}
      {isAdmin && token && (
        <QRCheckInScanner
          visible={showQRScanner}
          token={token}
          onClose={() => setShowQRScanner(false)}
        />
      )}

      {/* ── Marker Reject Reason Modal ─────────────────────────── */}
      <Modal
        visible={rejectReasonModalId !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRejectReasonModalId(null)}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
          <View style={{ backgroundColor: Colors.card, borderRadius: 20, padding: 24, width: '100%', maxWidth: 360, borderWidth: 1, borderColor: Colors.border, gap: 16 }}>
            <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 18, color: Colors.text }}>Reject Score</Text>
            <Text style={{ fontFamily: 'Inter_400Regular', fontSize: 14, color: Colors.textSecondary }}>
              Please provide a reason for rejecting this score. This will be visible to the player and committee.
            </Text>
            <TextInput
              placeholder="e.g. Score incorrect on hole 7"
              placeholderTextColor={Colors.muted}
              value={rejectReasonText}
              onChangeText={setRejectReasonText}
              multiline
              numberOfLines={3}
              style={{
                backgroundColor: Colors.surface,
                borderWidth: 1,
                borderColor: Colors.border,
                borderRadius: 12,
                padding: 12,
                color: Colors.text,
                fontFamily: 'Inter_400Regular',
                fontSize: 14,
                minHeight: 80,
                textAlignVertical: 'top',
              }}
            />
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Pressable
                onPress={() => { setRejectReasonModalId(null); setRejectReasonText(''); }}
                style={{ flex: 1, paddingVertical: 14, borderRadius: 12, borderWidth: 1, borderColor: Colors.border, alignItems: 'center' }}
              >
                <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 15, color: Colors.textSecondary }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  const id = rejectReasonModalId;
                  if (id === null) return;
                  setRejectReasonModalId(null);
                  submitMarkerReject(id, rejectReasonText);
                }}
                disabled={validateActionLoading}
                style={{ flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: '#ef4444', alignItems: 'center', opacity: validateActionLoading ? 0.5 : 1 }}
              >
                <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 15, color: '#fff' }}>Reject</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  batchConflictBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fff5e6",
    borderColor: Colors.bogey,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginHorizontal: 12,
    marginTop: 8,
    borderRadius: 8,
  },
  batchConflictText: { fontSize: 13, fontWeight: "600", color: Colors.bogey, flex: 1 },
  conflictBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  conflictCard: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: Colors.background,
    borderRadius: 14,
    padding: 18,
    gap: 12,
  },
  conflictTitle: { fontSize: 17, fontWeight: "700", color: Colors.text },
  conflictBody: { fontSize: 14, color: Colors.textSecondary, lineHeight: 19 },
  conflictRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  conflictBtn: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 10,
    alignItems: "center",
    gap: 4,
  },
  conflictBtnLabel: { fontSize: 13, fontWeight: "700", color: Colors.text },
  conflictBtnValue: { fontSize: 12, color: Colors.textSecondary, textAlign: "center" },
  container: { flex: 1, backgroundColor: Colors.background },
  watchToast: {
    position: "absolute",
    top: 8,
    left: 16,
    right: 16,
    zIndex: 1000,
    elevation: 12,
    alignItems: "center",
  },
  watchToastInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(20, 20, 20, 0.92)",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "rgba(201, 168, 76, 0.45)",
    maxWidth: 420,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
  },
  watchToastText: {
    flex: 1,
    color: "#fff",
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingBottom: 16,
    paddingTop: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  brand: {
    fontFamily: "Inter_700Bold",
    fontSize: 10,
    color: Colors.text,
    letterSpacing: 3,
    marginBottom: 2,
  },
  headerTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 24,
    color: Colors.text,
  },
  logoContainer: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  logoImage: { width: 36, height: 36, marginBottom: 4 },
  stepContent: { flex: 1 },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
  },
  loadingText: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    color: Colors.textSecondary,
  },
  emptyTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 18,
    color: Colors.text,
    textAlign: "center",
  },
  emptySubtitle: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: "center",
  },
  stepLabel: {
    fontFamily: "Inter_700Bold",
    fontSize: 11,
    color: Colors.muted,
    letterSpacing: 2,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  stepHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 8,
    paddingBottom: 4,
    gap: 8,
  },
  backBtn: {
    padding: 12,
    paddingLeft: 16,
  },
  // Tournament selector
  selectCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.card,
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  selectCardLeft: { flex: 1, marginRight: 8 },
  calBtn: {
    padding: 7, borderRadius: 10,
    backgroundColor: Colors.primary + "18",
    borderWidth: 1, borderColor: Colors.primary + "40",
    alignItems: "center", justifyContent: "center",
  },
  selectCardTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
    color: Colors.text,
    marginBottom: 4,
  },
  selectCardSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: Colors.textSecondary,
  },
  // Player selector
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginVertical: 8,
    backgroundColor: Colors.card,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  searchInput: {
    flex: 1,
    fontFamily: "Inter_400Regular",
    fontSize: 15,
    color: Colors.text,
  },
  playerRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.card,
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 12,
  },
  playerAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primary + "30",
    borderWidth: 1,
    borderColor: Colors.primary + "50",
    alignItems: "center",
    justifyContent: "center",
  },
  playerInitials: {
    fontFamily: "Inter_700Bold",
    fontSize: 16,
    color: Colors.primary,
  },
  playerRowName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
    color: Colors.text,
  },
  playerRowSub: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  // Session header
  sessionHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 10,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  sessionName: {
    fontFamily: "Inter_700Bold",
    fontSize: 15,
    color: Colors.text,
  },
  sessionTournament: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 1,
  },
  rulesIconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(201,168,76,0.12)",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 8,
  },
  sessionScore: {
    alignItems: "center",
    backgroundColor: Colors.card,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  sessionScoreValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 20,
  },
  sessionScoreLabel: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: Colors.muted,
    marginTop: 1,
  },
  // Progress bar
  progressBar: {
    height: 3,
    backgroundColor: Colors.border,
  },
  progressFill: {
    height: 3,
    backgroundColor: Colors.primary,
  },
  // Hole dots
  holeDots: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
  },
  holeDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
  },
  holeDotCurrent: {
    borderWidth: 2,
  },
  holeDotText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    color: Colors.textSecondary,
  },
  holeDotSgBadge: {
    position: "absolute",
    top: -2,
    right: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: Colors.background,
  },
  // Hole card
  scoringContent: {
    padding: 16,
    gap: 16,
  },
  holeCard: {
    backgroundColor: Colors.card,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 20,
    gap: 20,
    position: "relative",
  },
  holeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  holeNumberBadge: {
    backgroundColor: Colors.primary + "20",
    borderRadius: 16,
    paddingHorizontal: 20,
    paddingVertical: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: Colors.primary + "40",
  },
  holeNumberLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    color: Colors.primary,
    letterSpacing: 2,
  },
  holeNumberValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 36,
    color: Colors.primary,
    lineHeight: 42,
  },
  holeInfoRight: {
    alignItems: "flex-end",
    gap: 6,
  },
  parBadge: {
    flexDirection: "row",
    gap: 6,
    alignItems: "baseline",
  },
  parLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    color: Colors.muted,
    letterSpacing: 1,
  },
  parValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 32,
    color: Colors.text,
  },
  yardage: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: Colors.textSecondary,
  },
  yardagePlaysLike: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    marginTop: 1,
  },
  hcpText: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: Colors.muted,
  },
  noParWarning: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fef3c7",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: "#f59e0b",
  },
  noParWarningText: {
    flex: 1,
    fontSize: 12,
    color: "#92400e",
    fontFamily: "Inter_600SemiBold",
  },
  allowanceBadge: {
    backgroundColor: Colors.primary + "25",
    borderRadius: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: Colors.primary + "50",
  },
  allowanceBadgeText: {
    fontFamily: "Inter_700Bold",
    fontSize: 11,
    color: Colors.primary,
  },
  maxBadge: {
    position: "absolute",
    bottom: -10,
    alignSelf: "center",
    backgroundColor: "#ef444420",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: "#ef444460",
  },
  maxBadgeText: {
    fontFamily: "Inter_700Bold",
    fontSize: 10,
    color: "#ef4444",
    letterSpacing: 1,
  },
  // Score controls
  scoreControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 8,
  },
  scoreBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  scoreDisplay: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    gap: 2,
  },
  scoreNumber: {
    fontFamily: "Inter_700Bold",
    fontSize: 72,
    lineHeight: 78,
  },
  scoreDiff: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
  },
  scoreLabelBadge: {
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 6,
    alignSelf: "center",
    borderWidth: 1,
  },
  puttsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    marginTop: 12,
  },
  puttsLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    letterSpacing: 1,
    color: Colors.textSecondary,
  },
  puttsChips: {
    flexDirection: "row",
    gap: 6,
  },
  puttsChip: {
    minWidth: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
  },
  puttsChipActive: {
    backgroundColor: "rgba(201,168,76,0.15)",
    borderColor: "rgba(201,168,76,0.5)",
  },
  puttsChipText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: Colors.text,
  },
  scoreLabelText: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
    letterSpacing: 1,
  },
  savingOverlay: {
    position: "absolute",
    top: 12,
    right: 12,
  },
  // Navigation
  mapBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    alignSelf: "center",
    marginTop: 6,
    marginBottom: 2,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: Colors.primary + "40",
    backgroundColor: Colors.primary + "10",
  },
  mapBtnText: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    color: Colors.primary,
  },
  navBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  navBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    padding: 8,
  },
  navBtnText: {
    fontFamily: "Inter_500Medium",
    fontSize: 15,
    color: Colors.textSecondary,
  },
  nextBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.primary + "20",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: Colors.primary + "40",
  },
  nextBtnText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
    color: Colors.primary,
  },
  finishBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  finishBtnText: {
    fontFamily: "Inter_700Bold",
    fontSize: 15,
    color: "#000",
  },
  // Completion screen
  completeScreen: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 32,
    paddingVertical: 40,
  },
  completeTrophy: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: Colors.secondary + "20",
    borderWidth: 1,
    borderColor: Colors.secondary + "40",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  completeTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 28,
    color: Colors.text,
    textAlign: "center",
  },
  completeName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 18,
    color: Colors.textSecondary,
  },
  completeTournament: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    color: Colors.muted,
  },
  summaryCard: {
    width: "100%",
    backgroundColor: Colors.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 20,
    gap: 16,
    marginTop: 12,
  },
  summaryHero: {
    alignItems: "center",
    gap: 4,
  },
  summaryStrokesLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    color: Colors.muted,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  summaryStrokesValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 56,
    color: Colors.text,
    lineHeight: 62,
  },
  summaryToParValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 28,
    lineHeight: 32,
  },
  statRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingTop: 16,
  },
  statItem: {
    alignItems: "center",
    gap: 2,
  },
  statCount: {
    fontFamily: "Inter_700Bold",
    fontSize: 22,
  },
  statLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    letterSpacing: 0.5,
  },
  bestHoleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingTop: 12,
  },
  bestHoleLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    color: Colors.muted,
  },
  bestHoleValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
    color: Colors.text,
  },
  doneBtn: {
    marginTop: 16,
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingHorizontal: 40,
    paddingVertical: 14,
  },
  doneBtnText: {
    fontFamily: "Inter_700Bold",
    fontSize: 16,
    color: "#000",
  },
  // Marker entry button
  markerEntryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 16,
    paddingVertical: 14,
    paddingHorizontal: 20,
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    justifyContent: "center",
  },
  markerEntryBtnText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    color: Colors.textSecondary,
  },
  // Submit for validation button
  validateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: Colors.primary,
    backgroundColor: Colors.primary + "15",
    width: "100%",
  },
  validateBtnText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    color: Colors.primary,
  },
  // Code display box
  codeBox: {
    width: "100%",
    backgroundColor: Colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 20,
    alignItems: "center",
    marginTop: 8,
    gap: 6,
  },
  codeLabel: {
    fontFamily: "Inter_700Bold",
    fontSize: 11,
    color: Colors.muted,
    letterSpacing: 2,
  },
  codeValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 42,
    color: Colors.primary,
    letterSpacing: 8,
  },
  codeTotal: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    color: Colors.textSecondary,
  },
  codeInstructions: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: "center",
    lineHeight: 20,
  },
  // Code entry
  codeEntryRow: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
  },
  codeInput: {
    flex: 1,
    backgroundColor: Colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 20,
    paddingVertical: 14,
    fontFamily: "Inter_700Bold",
    fontSize: 28,
    color: Colors.text,
    letterSpacing: 6,
    textAlign: "center",
  },
  lookupBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 14,
    minWidth: 70,
    alignItems: "center",
    justifyContent: "center",
  },
  lookupBtnText: {
    fontFamily: "Inter_700Bold",
    fontSize: 15,
    color: "#000",
  },
  // Validate card
  validateCard: {
    backgroundColor: Colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 20,
    gap: 12,
  },
  validateCardName: {
    fontFamily: "Inter_700Bold",
    fontSize: 18,
    color: Colors.text,
    textAlign: "center",
  },
  validateCardTotal: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: "center",
  },
  validateScoreGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "center",
  },
  validateScoreCell: {
    backgroundColor: Colors.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
    width: 44,
    alignItems: "center",
    paddingVertical: 6,
  },
  validateScoreHole: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: Colors.muted,
  },
  validateScoreVal: {
    fontFamily: "Inter_700Bold",
    fontSize: 16,
    color: Colors.text,
  },
  validateActions: {
    flexDirection: "row",
    gap: 12,
    marginTop: 4,
  },
  rejectBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: "#ff4444",
    backgroundColor: "#ff444415",
  },
  rejectBtnText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
    color: "#ff4444",
  },
  approveBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: Colors.primary,
  },
  approveBtnText: {
    fontFamily: "Inter_700Bold",
    fontSize: 15,
    color: "#000",
  },
  // Weather strip
  weatherStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  weatherStripContainer: { gap: 4 },
  weatherIcon: { fontSize: 14 },
  weatherText: { fontFamily: "Inter_400Regular", fontSize: 12, color: Colors.textSecondary },
  weatherSep: { fontFamily: "Inter_400Regular", fontSize: 12, color: Colors.muted },
  weatherAlertStrip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f59e0b18",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: "#f59e0b44",
  },
  weatherAlertText: { fontFamily: "Inter_500Medium", fontSize: 11, color: "#f59e0b" },
  // GPS distance
  gpsDistRow: {
    flexDirection: "row",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.primary + "30",
    backgroundColor: Colors.primary + "08",
    overflow: "hidden",
  },
  gpsDistItem: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    gap: 2,
  },
  gpsDistCentre: {
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: Colors.primary + "30",
  },
  gpsDistLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 9,
    color: Colors.muted,
    letterSpacing: 1,
  },
  gpsDistVal: {
    fontFamily: "Inter_700Bold",
    fontSize: 22,
    color: Colors.textSecondary,
  },
  gpsDistUnit: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: Colors.muted,
  },
  gpsDistPlaysLike: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    color: Colors.muted,
    marginTop: 2,
  },
  // Shot tracking
  shotRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  shotBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: Colors.secondary + "15",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: Colors.secondary + "30",
  },
  shotBtnText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    color: Colors.secondary,
  },
  infoBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Colors.border,
  },
  shotPanel: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 14,
    gap: 12,
  },
  shotPanelTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    color: Colors.muted,
    letterSpacing: 1,
  },
  shotTypeRow: {
    flexDirection: "row",
    gap: 8,
  },
  shotTypeChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  shotTypeChipActive: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primary + "15",
  },
  shotTypeChipText: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    color: Colors.textSecondary,
  },
  logShotBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: Colors.primary,
    borderRadius: 10,
    paddingVertical: 10,
  },
  logShotBtnText: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
    color: "#000",
  },
  logShotDist: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: "#00000070",
  },
  // Hole info card
  holeInfoCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 14,
    gap: 10,
  },
  holeInfoDesc: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 20,
  },
  holeInfoGrid: {
    flexDirection: "row",
    gap: 12,
  },
  holeInfoCell: {
    alignItems: "center",
    gap: 2,
  },
  holeInfoLabel: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: Colors.muted,
  },
  holeInfoVal: {
    fontFamily: "Inter_700Bold",
    fontSize: 18,
  },
  holeInfoGPS: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  holeInfoGPSText: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: Colors.muted,
  },
  holeInfoNoGPS: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: Colors.muted,
    fontStyle: "italic",
  },
  // Offline indicator
  offlinePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: Colors.bogey + "20",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: Colors.bogey + "40",
  },
  offlinePillText: {
    fontFamily: "Inter_700Bold",
    fontSize: 8,
    color: Colors.bogey,
    letterSpacing: 0.5,
  },
  // Share button
  shareBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 4,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    width: "100%",
  },
  shareBtnText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    color: Colors.textSecondary,
  },
  cardModalBg: {
    flex: 1,
    backgroundColor: "#0D1117",
  },
  cardModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  cardModalTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#F0F4F8",
    fontFamily: "Inter_700Bold",
  },
  cardModalClose: {
    padding: 4,
  },
  cardModalScroll: {
    alignItems: "center",
    paddingVertical: 20,
    paddingHorizontal: 16,
  },
  cardModalHint: {
    fontSize: 13,
    color: "#6B7280",
    marginBottom: 16,
    textAlign: "center",
  },
  cardCapture: {
    borderRadius: 16,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 12,
  },
  cardModalActions: {
    paddingHorizontal: 20,
    paddingVertical: 20,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.06)",
  },
  cardShareBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#C9A84C",
    borderRadius: 14,
    paddingVertical: 16,
  },
  cardShareBtnText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#0D1117",
    fontFamily: "Inter_700Bold",
  },
  cardCancelBtn: {
    alignItems: "center",
    paddingVertical: 12,
  },
  cardCancelBtnText: {
    fontSize: 14,
    color: "#6B7280",
    fontFamily: "Inter_500Medium",
  },
  // Per-hole SG card
  sgCard: {
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
    gap: 8,
  },
  sgCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  sgCardTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    color: Colors.muted,
    letterSpacing: 0.8,
  },
  sgCardRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sgStatCell: {
    alignItems: "center",
    flex: 1,
    gap: 2,
  },
  sgStatLabel: {
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    color: Colors.muted,
  },
  sgStatValue: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
  },
  sgEstimateNote: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: Colors.muted,
    marginTop: 6,
    fontStyle: "italic",
    lineHeight: 13,
  },
  // Round-level SG totals strip
  sgTotalsStrip: {
    marginHorizontal: 16,
    marginTop: 4,
    marginBottom: 4,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  sgTotalsHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  sgTotalsTitle: {
    flex: 1,
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    color: Colors.muted,
    letterSpacing: 0.8,
  },
  sgTotalsShots: {
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    color: Colors.muted,
  },
  sgTotalsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  // Review Shots button
  reviewShotsBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: Colors.primary + "15",
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.primary + "40",
  },
  reviewShotsBtnText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: Colors.primary,
  },
});
