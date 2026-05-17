import AsyncStorage from "@react-native-async-storage/async-storage";
import { Feather, Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { Video, ResizeMode } from "expo-av";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Dimensions,
  FlatList,
  Image,
  Keyboard,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { fetchPublic, fetchPortal } from "@/utils/api";
import { BASE_URL } from "@/utils/api";
import { useAuth } from "@/context/auth";
import MemberAvatar from "@/components/MemberAvatar";
import LiveOddsWidget from "@/components/LiveOddsWidget";
import InlineAdBanner from "@/components/InlineAdBanner";
import ConsentPrompt from "@/components/ConsentPrompt";
import { FollowButton } from "@/components/FollowButton";
import { useFolloweeIds } from "@/hooks/useFolloweeIds";
import { usePrewarmPublicProfileHandles } from "@/hooks/usePublicProfileHandle";
import { getLocale } from "@/i18n";
import { useTranslation } from "react-i18next";

const QUICK_EMOJIS = ["👍", "❤️", "😂", "🎉", "🏌️", "⛳"];

interface Tournament {
  id: number;
  name: string;
  format: string;
  status: string;
  organizationName: string;
  startDate?: string | null;
  endDate?: string | null;
}

interface HoleScore {
  hole: number; round: number; strokes: number; par: number; toPar: number;
  stablefordPoints?: number; putts?: number | null; fairwayHit?: boolean | null; girHit?: boolean | null; isVerified?: boolean;
  parBogeyResult?: "W" | "L" | "H" | null;
}

interface RoundScore {
  round: number;
  grossScore: number;
  scoreToPar: number;
  netScore: number | null;
  stablefordPoints: number | null;
  holesPlayed: number;
  isComplete: boolean;
}

export interface LeaderboardEntry {
  playerId: number;
  userId?: number | null;
  playerName: string;
  position: number;
  positionDisplay: string;
  grossScore: number | null;
  netScore: number | null;
  scoreToPar: number | null;
  netToPar: number | null;
  stablefordPoints?: number | null;
  parBogeyScore?: number | null;
  thru: string;
  flight: string | null;
  flights: string[];
  handicapIndex: number;
  holeScores: HoleScore[];
  roundScores: RoundScore[];
  currentRound: number;
  stats: { eagles: number; birdies: number; pars: number; bogeys: number; doublePlus: number };
  isVerified: boolean;
  madeCut: boolean | null;
  profileImage?: string | null;
  firstName?: string;
  lastName?: string;
  holesCompleted?: number;
  currentHole?: number | null;
}

// Task #1791 — `userId` carries the linked appUsersTable.id of the
// teammate (null when the player isn't connected to a portal account).
// Used to make each team-row member name tappable into /member/[userId].
interface TeamMember { playerId: number; userId?: number | null; playerName: string; handicapIndex: number; grossScore: number | null; }
interface TeamEntry {
  position: number; positionDisplay: string;
  teamId: number; teamName: string; teamColour: string | null;
  grossScore: number | null; netScore: number | null;
  scoreToPar: number | null; netToPar: number | null;
  stablefordPoints: number | null; holesCompleted: number;
  members: TeamMember[];
}

interface MobileSponsor { id: number; name: string; logoUrl: string | null; websiteUrl: string | null; }

interface Leaderboard {
  tournamentId: number;
  tournamentName: string;
  entries: LeaderboardEntry[];
  netEntries: LeaderboardEntry[];
  stablefordEntries: LeaderboardEntry[];
  byFlight: Record<string, LeaderboardEntry[]>;
  flights: string[];
  lastUpdated: string;
  coursePar: number;
  rounds: number;
  organizationId: number | null;
  leaderboardType?: string | null;
  availableViews?: string[];
  isTeamFormat?: boolean;
  teamEntries?: TeamEntry[];
  sponsors?: MobileSponsor[];
  format?: string | null;
  cutLineIndex?: number | null;
}

export type ScoreMode = "gross" | "net" | "stableford";
type LeaderboardView = "leaderboard" | "tracker" | "tee-sheet" | "announcements" | "gallery" | "chat" | "documents";

interface NotableEvent {
  tournamentId: number;
  playerId: number | null;
  playerName: string;
  holeNumber: number;
  strokes: number;
  par: number;
  toPar: number;
  eventType: "hole_in_one" | "eagle" | "birdie" | "round_start" | "round_finish" | "tee_off";
  round: number;
  occurredAt: string;
}

interface PaceGroup {
  teeTimeId: number;
  teeTime: string;
  round: number;
  startingHole: number;
  players: { id: number; name: string }[];
  currentHole: number | null;
  minutesUntilTeeOff: number;
  status: "scheduled" | "upcoming" | "in_progress" | "complete";
  lastHoleCompletedAt: string | null;
}

interface SpectatorFollow {
  id: number;
  tournamentId: number;
  playerId: number | null;
  teeTimeId: number | null;
  notifyBirdie: boolean;
  notifyEagle: boolean;
  notifyHio: boolean;
  notifyRoundStart: boolean;
  notifyRoundFinish: boolean;
  notifyTeeOff: boolean;
}

interface GalleryItem {
  id: number;
  objectPath: string;
  thumbnailPath: string | null;
  caption: string | null;
  uploaderName: string | null;
  uploadedByUserId: number | null;
  mediaType: string;
  approved: boolean;
  createdAt: string;
}

interface ChatMessage {
  id: number;
  displayName: string;
  body: string;
  messageType: string;
  mediaId: number | null;
  mediaThumbnailPath?: string | null;
  mediaObjectPath?: string | null;
  reactions: Record<string, number[]>;
  isPinned: boolean;
  createdAt: string;
}

interface ChatRoom {
  roomId: number | null;
  enabled: boolean;
  organizationId: number | null;
  messages: ChatMessage[];
}

interface OrgChatResponse {
  room: { id: number; enabled: boolean; organizationId: number };
  messages: ChatMessage[];
}

interface Announcement {
  id: number;
  body: string;
  type: string;
  authorName: string | null;
  sentAt: string;
}

function getScoreColor(toPar: number | null): string {
  if (toPar === null) return Colors.textSecondary;
  if (toPar <= -2) return Colors.eagle;
  if (toPar === -1) return Colors.birdie;
  if (toPar === 0) return Colors.par;
  if (toPar === 1) return Colors.bogey;
  return Colors.doubleOrWorse;
}

function formatScore(score: number | null): string {
  if (score === null) return "-";
  if (score === 0) return "E";
  return score > 0 ? `+${score}` : `${score}`;
}

function getPositionStyle(position: number) {
  if (position === 1) return { color: Colors.secondary, fontFamily: "Inter_700Bold" as const };
  if (position === 2) return { color: "#94a3b8", fontFamily: "Inter_700Bold" as const };
  if (position === 3) return { color: "#cd7f32", fontFamily: "Inter_700Bold" as const };
  return { color: Colors.textSecondary, fontFamily: "Inter_600SemiBold" as const };
}

function ScorecardModal({ entry, onClose }: { entry: LeaderboardEntry; onClose: () => void }) {
  const { t } = useTranslation('leaderboard');
  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose} accessibilityLabel="Close scorecard">
        <Pressable
          style={styles.modalSheet}
          onPress={e => e.stopPropagation()}
          accessibilityViewIsModal
          importantForAccessibility="yes"
        >
          <View style={styles.modalHandle} accessible={false} />
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalName} accessibilityRole="header">{entry.playerName}</Text>
              <Text style={styles.modalSub}>HCP {entry.handicapIndex} · {entry.flight ?? "No flight"}</Text>
            </View>
            <Pressable
              onPress={onClose}
              style={styles.modalClose}
              accessibilityRole="button"
              accessibilityLabel="Close scorecard"
            >
              <Feather name="x" size={20} color={Colors.textSecondary} />
            </Pressable>
          </View>

          {entry.holeScores.length === 0 ? (
            <View style={styles.modalEmpty}>
              <Text style={styles.modalEmptyText}>{t('noScoresYet')}</Text>
            </View>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false}>
              {/* Stats row */}
              {entry.stats && (
                <View style={styles.statsRow}>
                  {[["🦅", entry.stats.eagles, t('stats.eagles')], ["🐦", entry.stats.birdies, t('stats.birdies')], ["⚑", entry.stats.pars, t('stats.pars')], ["", entry.stats.bogeys, t('stats.bogeys')], ["", entry.stats.doublePlus, t('stats.dblPlus')]].map(([icon, val, label]) => (
                    <View key={String(label)} style={styles.statCell}>
                      <Text style={styles.statIcon}>{icon}</Text>
                      <Text style={styles.statValue}>{val}</Text>
                      <Text style={styles.statLabel}>{label}</Text>
                    </View>
                  ))}
                </View>
              )}

              {/* Hole-by-hole */}
              <View style={styles.scorecardHeader}>
                <Text style={[styles.scColHead, { flex: 1 }]}>HOLE</Text>
                <Text style={[styles.scColHead, { width: 44, textAlign: "center" }]}>PAR</Text>
                <Text style={[styles.scColHead, { width: 44, textAlign: "center" }]}>SCORE</Text>
                <Text style={[styles.scColHead, { width: 44, textAlign: "center" }]}>+/-</Text>
              </View>
              {entry.holeScores.map(h => (
                <View key={h.hole} style={styles.scRow}>
                  <Text style={[styles.scCell, { flex: 1 }]}>Hole {h.hole}</Text>
                  <Text style={[styles.scCell, { width: 44, textAlign: "center", color: Colors.muted }]}>{h.par}</Text>
                  <View style={{ width: 44, alignItems: "center" }}>
                    <View style={[styles.scoreCircle,
                      h.toPar <= -2 && styles.eagleCircle,
                      h.toPar === -1 && styles.birdieCircle,
                      h.toPar === 1 && styles.bogeyCircle,
                      h.toPar >= 2 && styles.doubleCircle,
                    ]}>
                      <Text style={[styles.scoreCircleText, { color: getScoreColor(h.toPar) }]}>{h.strokes}</Text>
                    </View>
                  </View>
                  <Text style={[styles.scCell, { width: 44, textAlign: "center", color: getScoreColor(h.toPar), fontFamily: "Inter_700Bold" }]}>{formatScore(h.toPar)}</Text>
                </View>
              ))}

              {/* Total row */}
              <View style={[styles.scRow, styles.totalRow]}>
                <Text style={[styles.scCell, { flex: 1, fontFamily: "Inter_700Bold", color: Colors.text }]}>TOTAL</Text>
                <Text style={[styles.scCell, { width: 44, textAlign: "center", color: Colors.muted, fontFamily: "Inter_700Bold" }]}>
                  {entry.holeScores.reduce((a, h) => a + h.par, 0)}
                </Text>
                <Text style={[styles.scCell, { width: 44, textAlign: "center", fontFamily: "Inter_700Bold", color: Colors.text }]}>{entry.grossScore ?? "-"}</Text>
                <Text style={[styles.scCell, { width: 44, textAlign: "center", fontFamily: "Inter_700Bold", color: getScoreColor(entry.scoreToPar) }]}>{formatScore(entry.scoreToPar)}</Text>
              </View>
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export function LeaderboardRow({ entry, mode, format, index, onPress, onProfilePress, currentUserId, isFollowing, showFollow }: { entry: LeaderboardEntry; mode: ScoreMode; format?: string | null; index: number; onPress: () => void; onProfilePress?: (entry: LeaderboardEntry) => void; currentUserId?: number | null; isFollowing?: boolean; showFollow?: boolean }) {
  const isStablefordFmt = format === "stableford" || format === "team_stableford";
  const isParBogeyFmt = format === "par_bogey";
  // maximum_score is capped stroke play — same display as standard stroke play
  const toPar = mode === "net" ? entry.netToPar : entry.scoreToPar;
  const total = mode === "net" ? entry.netScore : entry.grossScore;
  const scoreColor = getScoreColor(toPar);
  const posStyle = getPositionStyle(entry.position);
  const missedCut = entry.madeCut === false;

  const scoreDisplay = isStablefordFmt
    ? (entry.stablefordPoints != null ? `${entry.stablefordPoints} pts` : "–")
    : isParBogeyFmt
      ? (() => {
          const s = entry.parBogeyScore ?? null;
          if (s === null) return "–";
          if (s === 0) return "A/S";
          return s > 0 ? `+${s}` : `${s}`;
        })()
      : (total ?? "–").toString();

  const badgeColor = isStablefordFmt
    ? "#C9A84C"
    : isParBogeyFmt
      ? getScoreColor(entry.parBogeyScore != null ? -entry.parBogeyScore : null)
      : scoreColor;

  const positionLabel = (isStablefordFmt || isParBogeyFmt) ? entry.positionDisplay : (total !== null ? entry.positionDisplay : "–");
  const scoreA11y = isStablefordFmt
    ? (entry.stablefordPoints != null ? `${entry.stablefordPoints} stableford points` : "no score")
    : isParBogeyFmt
      ? (entry.parBogeyScore != null ? `par/bogey score ${entry.parBogeyScore > 0 ? "+" : ""}${entry.parBogeyScore}` : "no score")
      : (total != null ? `${mode === "net" ? "net" : "gross"} ${total}, ${formatScore(toPar)} to par` : "no score");
  const a11yRowLabel = `Position ${positionLabel}, ${entry.playerName}${entry.flight ? `, ${entry.flight}` : ""}, ${scoreA11y}, through hole ${entry.thru}${missedCut ? ", missed cut" : ""}`;
  return (
    <Pressable
      onPress={onPress}
      style={[styles.row, index === 0 && styles.firstRow, missedCut && styles.rowMissedCut]}
      accessibilityRole="button"
      accessibilityLabel={a11yRowLabel}
    >
      <Text style={[styles.position, posStyle, missedCut && styles.textMuted]}>{positionLabel}</Text>
      <MemberAvatar
        profileImage={entry.profileImage}
        firstName={entry.firstName ?? entry.playerName.split(" ")[0] ?? "?"}
        lastName={entry.lastName ?? entry.playerName.split(" ").slice(1).join(" ") ?? ""}
        size={32}
      />
      <View style={[styles.playerInfo, { marginLeft: 6 }]}>
        <View style={styles.playerNameRow}>
          {/* Task #1457 — tapping the player's name opens the public
              profile viewer (or private fallback) instead of the
              scorecard modal. The wrapping row Pressable still handles
              taps elsewhere on the row. */}
          {onProfilePress && entry.userId != null ? (
            <Pressable
              onPress={() => onProfilePress(entry)}
              hitSlop={6}
              style={{ flex: 1 }}
              accessibilityRole="link"
              accessibilityLabel={`Open ${entry.playerName}'s profile`}
              testID={`leaderboard-name-${entry.userId}`}
            >
              <Text style={[styles.playerName, missedCut && styles.textMuted]} numberOfLines={1}>{entry.playerName}</Text>
            </Pressable>
          ) : (
            <Text style={[styles.playerName, missedCut && styles.textMuted]} numberOfLines={1}>{entry.playerName}</Text>
          )}
          {missedCut && (
            <View style={styles.mcBadge}><Text style={styles.mcBadgeText}>MC</Text></View>
          )}
          {!missedCut && entry.isVerified && (
            <View style={styles.verifiedBadge}><Text style={styles.verifiedText}>✓</Text></View>
          )}
          {showFollow && entry.userId != null && entry.userId !== currentUserId && (
            <View style={{ marginLeft: 6 }}>
              <FollowButton userId={entry.userId} initialFollowing={!!isFollowing} size="sm" />
            </View>
          )}
        </View>
        {entry.flight ? <Text style={[styles.flight, missedCut && styles.textMuted]}>{entry.flight}</Text> : null}
      </View>
      <Text style={[styles.thru, missedCut && styles.textMuted]}>{entry.thru}</Text>
      <Text style={[styles.grossScore, missedCut && styles.textMuted, isStablefordFmt && { color: "#C9A84C", fontSize: 14 }]}>{scoreDisplay}</Text>
      {!isStablefordFmt && !isParBogeyFmt && (
        <View style={[styles.scoreToParBadge, { backgroundColor: missedCut ? "rgba(255,255,255,0.04)" : scoreColor + "20" }]}>
          <Text style={[styles.scoreToPar, { color: missedCut ? "rgba(255,255,255,0.3)" : scoreColor }]}>{formatScore(toPar)}</Text>
        </View>
      )}
      {isParBogeyFmt && (
        <View style={[styles.scoreToParBadge, { backgroundColor: missedCut ? "rgba(255,255,255,0.04)" : badgeColor + "20" }]}>
          <Text style={[styles.scoreToPar, { color: missedCut ? "rgba(255,255,255,0.3)" : badgeColor }]}>{scoreDisplay}</Text>
        </View>
      )}
    </Pressable>
  );
}

// ── Compete hub types ──────────────────────────────────────────────────────────

interface MyLeague {
  memberId: number;
  leagueId: number;
  leagueName: string;
  leagueFormat: string;
  leagueStatus: string;
  seasonStart: string | null;
  seasonEnd: string | null;
  position: number | null;
  roundsPlayed: number | null;
  paymentStatus: string;
}

interface RankingEntry {
  handicapIndex: number;
  recordedAt: string | null;
}

type CompeteSegment = "tournaments" | "leagues" | "rankings";

const GOLD = "#C9A84C";
const LEAGUE_STATUS_COLOR: Record<string, string> = { active: "#22c55e", upcoming: "#C9A84C", completed: "#94b4a4" };

function getTournamentStatusColor(status: string): string {
  const s = status?.toLowerCase();
  if (s === "active" || s === "live") return "#22c55e";
  if (s === "upcoming") return "#C9A84C";
  if (s === "completed" || s === "finished") return "#94b4a4";
  return "#94b4a4";
}

function fmtShortDate(d: string | null | undefined) {
  if (!d) return "";
  return new Date(d).toLocaleDateString(getLocale(), { month: "short", day: "numeric" });
}

export default function LeaderboardScreen() {
  const { t } = useTranslation('leaderboard');
  const insets = useSafeAreaInsets();
  const isWeb = Platform.OS === "web";
  const topPadding = isWeb ? 67 : insets.top;
  const params = useLocalSearchParams<{ tournamentId?: string; leagueId?: string }>();
  const { token, user } = useAuth();
  const router = useRouter();

  // Pre-fetch the IDs the viewer already follows so each leaderboard row's
  // <FollowButton> hydrates as "Following" without flashing "Follow" first
  // (Task #1420). Empty list when the viewer is not signed in.
  const { followeeIds } = useFolloweeIds(token);
  const followeeIdSet = React.useMemo(() => new Set<number>(followeeIds), [followeeIds]);

  // ── Compete Hub segment ──────────────────────────────────────────────
  const [activeSegment, setActiveSegment] = useState<CompeteSegment>(
    params.leagueId ? "leagues" : "tournaments"
  );

  // Leagues data
  const { data: myLeagues } = useQuery({
    queryKey: ["my-leagues-compete", token],
    queryFn: () => token ? fetchPortal<MyLeague[]>("/my-leagues", token).catch(() => [] as MyLeague[]) : Promise.resolve([] as MyLeague[]),
    enabled: activeSegment === "leagues" || !!params.leagueId,
    staleTime: 60_000,
  });

  // Rankings data (handicap trend as personal ranking history)
  const { data: rankingHistory } = useQuery({
    queryKey: ["ranking-history-compete", token],
    queryFn: async () => {
      if (!token) return [] as RankingEntry[];
      const res = await fetch(`${BASE_URL}/api/portal/rankings/history`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return [] as RankingEntry[];
      const data = await res.json() as RankingEntry[];
      return data;
    },
    enabled: activeSegment === "rankings" && !!token,
    staleTime: 60_000,
  });

  const { data: tournaments } = useQuery({
    queryKey: ["public-tournaments"],
    queryFn: () => fetchPublic<Tournament[]>("/tournaments"),
  });

  const [selectedTournamentId, setSelectedTournamentId] = useState<number | null>(
    params.tournamentId ? parseInt(params.tournamentId) : null
  );
  const [activeFlight, setActiveFlight] = useState<string>("Overall");
  const [mode, setMode] = useState<ScoreMode>("gross");
  const [modePersistKey] = useState(() => "lb_score_mode");
  const [selectedEntry, setSelectedEntry] = useState<LeaderboardEntry | null>(null);
  const [view, setView] = useState<LeaderboardView>("leaderboard");
  const [selectedRound, setSelectedRound] = useState<number>(0);
  const [expandedTeams, setExpandedTeams] = useState<Set<number>>(new Set());
  const [cutSectionExpanded, setCutSectionExpanded] = useState(false);

  // Modal visibility for the new UX controls
  const [tournamentPickerVisible, setTournamentPickerVisible] = useState(false);
  const [moreViewsVisible, setMoreViewsVisible] = useState(false);
  const [roundPickerVisible, setRoundPickerVisible] = useState(false);
  const [flightPickerVisible, setFlightPickerVisible] = useState(false);

  // Gallery state
  const [galleryItems, setGalleryItems] = useState<GalleryItem[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [lightboxItem, setLightboxItem] = useState<GalleryItem | null>(null);
  const [galleryCaption, setGalleryCaption] = useState("");
  const [galleryUploading, setGalleryUploading] = useState(false);
  // Task #620 — friendly consent prompt when API blocks photo/video uploads.
  const [consentPrompt, setConsentPrompt] = useState<{ message: string; category: string } | null>(null);

  const loadGallery = useCallback(async (orgId?: number | null) => {
    if (!selectedTournamentId) return;
    setGalleryLoading(true);
    try {
      // Use authenticated org endpoint when logged in (includes uploadedByUserId, own pending items)
      if (token && orgId) {
        const r = await fetch(`${BASE_URL}/api/organizations/${orgId}/media?tournamentId=${selectedTournamentId}`, {
          headers: { "Authorization": `Bearer ${token}` },
        });
        if (r.ok) { setGalleryItems(await r.json()); return; }
      }
      // Public fallback (only approved items, includes uploadedByUserId)
      const items = await fetchPublic<GalleryItem[]>(`/tournaments/${selectedTournamentId}/gallery`);
      setGalleryItems(items);
    } catch { /* silent */ } finally { setGalleryLoading(false); }
  }, [selectedTournamentId, token]);

  // Chat state
  const [chatRoom, setChatRoom] = useState<ChatRoom | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [seenChatCount, setSeenChatCount] = useState(0);
  const sseAbortRef = useRef<AbortController | null>(null);

  const loadChat = useCallback(async (orgId: number | null | undefined) => {
    if (!selectedTournamentId || !orgId || !token) {
      setChatRoom({ roomId: null, enabled: false, organizationId: null, messages: [] });
      setChatLoading(false);
      return;
    }
    setChatLoading(true);
    try {
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/chat/tournament/${selectedTournamentId}`, {
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("chat fetch failed");
      const data: OrgChatResponse = await res.json();
      setChatRoom({
        roomId: data.room.id,
        enabled: data.room.enabled,
        organizationId: data.room.organizationId,
        messages: data.messages,
      });
    } catch { setChatRoom(null); } finally { setChatLoading(false); }
  }, [selectedTournamentId, token]);

  // Connect to SSE stream once roomId is known
  const connectSSE = useCallback(async (roomId: number, authToken: string) => {
    if (sseAbortRef.current) sseAbortRef.current.abort();
    const ctrl = new AbortController();
    sseAbortRef.current = ctrl;
    try {
      const res = await fetch(`${BASE_URL}/api/sse/chat/${roomId}`, {
        headers: { Authorization: `Bearer ${authToken}` },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          for (const line of part.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const payload = JSON.parse(line.slice(6)) as { type: string; data: ChatMessage & { id?: number } };
              if (payload.type === "chat_message") {
                setChatRoom(prev => {
                  if (!prev) return prev;
                  if (prev.messages.some(m => m.id === payload.data.id)) return prev;
                  return { ...prev, messages: [...prev.messages, payload.data] };
                });
              } else if (payload.type === "chat_message_deleted") {
                setChatRoom(prev => {
                  if (!prev) return prev;
                  return { ...prev, messages: prev.messages.filter(m => m.id !== payload.data.id) };
                });
              } else if (payload.type === "chat_cleared") {
                setChatRoom(prev => prev ? { ...prev, messages: [] } : prev);
              }
            } catch { /* ignore malformed JSON */ }
          }
        }
      }
    } catch (e: unknown) {
      if ((e as Error)?.name !== "AbortError" && !ctrl.signal.aborted) {
        setTimeout(() => connectSSE(roomId, authToken), 5000);
      }
    }
  }, []);

  // Load chat room when user opens chat tab for the first time (or after tournament change)
  useEffect(() => {
    if (view === "chat" && selectedTournamentId && !chatRoom) {
      loadChat(leaderboard?.organizationId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedTournamentId]);

  // Reset chat room and abort SSE when tournament changes
  // (SSE stays alive across tab switches to allow unread badge accumulation)
  useEffect(() => {
    if (sseAbortRef.current) { sseAbortRef.current.abort(); sseAbortRef.current = null; }
    setChatRoom(null);
    setSeenChatCount(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTournamentId]);

  // Start SSE when roomId becomes available
  useEffect(() => {
    if (chatRoom?.roomId && token && chatRoom.enabled) {
      connectSSE(chatRoom.roomId, token);
    }
    return () => { if (sseAbortRef.current) { sseAbortRef.current.abort(); sseAbortRef.current = null; } };
  }, [chatRoom?.roomId, chatRoom?.enabled, token, connectSSE]);

  // Mark messages as seen when on chat tab
  useEffect(() => {
    if (view === "chat" && chatRoom) {
      setSeenChatCount(chatRoom.messages.length);
    }
  }, [view, chatRoom?.messages.length]);

  const unreadChatCount = view !== "chat" ? Math.max(0, (chatRoom?.messages.length ?? 0) - seenChatCount) : 0;

  const sendChatMessage = async () => {
    if (!chatInput.trim() || !token || !chatRoom?.organizationId || !selectedTournamentId) return;
    const body = chatInput.trim();
    setChatInput("");
    Keyboard.dismiss();
    setChatSending(true);
    try {
      await fetch(`${BASE_URL}/api/organizations/${chatRoom.organizationId}/chat/tournament/${selectedTournamentId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ body }),
      });
      // SSE stream will deliver the new message; no need to reload
    } catch { /* silent */ } finally { setChatSending(false); }
  };

  useEffect(() => {
    if (!selectedTournamentId && tournaments?.length) {
      setSelectedTournamentId(tournaments[0].id);
    }
  }, [tournaments, selectedTournamentId]);

  useEffect(() => {
    if (params.tournamentId) setSelectedTournamentId(parseInt(params.tournamentId));
  }, [params.tournamentId]);

  const queryClient = useQueryClient();
  const { data: leaderboard, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["leaderboard", selectedTournamentId],
    queryFn: () => fetchPublic<Leaderboard>(`/tournaments/${selectedTournamentId}/leaderboard`),
    enabled: !!selectedTournamentId,
    refetchInterval: 30000,
  });

  // Spectator feeds — notable moments + pace/tee-off countdown (Task #442)
  const { data: notableData } = useQuery({
    queryKey: ["notable-events", selectedTournamentId],
    queryFn: () => fetchPublic<{ events: NotableEvent[] }>(`/tournaments/${selectedTournamentId}/notable-events?limit=20`).catch(() => ({ events: [] })),
    enabled: !!selectedTournamentId && view === "leaderboard",
    refetchInterval: view === "leaderboard" ? 30000 : false,
  });
  const { data: paceData } = useQuery({
    queryKey: ["pace-board", selectedTournamentId],
    queryFn: () => fetchPublic<{ groups: PaceGroup[] }>(`/tournaments/${selectedTournamentId}/pace-board`).catch(() => ({ groups: [] })),
    enabled: !!selectedTournamentId && view === "leaderboard",
    refetchInterval: view === "leaderboard" ? 60000 : false,
  });
  const { data: followsData } = useQuery({
    queryKey: ["spectator-follows", selectedTournamentId, token],
    queryFn: () => token && selectedTournamentId
      ? fetchPortal<{ follows: SpectatorFollow[] }>(`/spectator-follows?tournamentId=${selectedTournamentId}`, token).catch(() => ({ follows: [] }))
      : Promise.resolve({ follows: [] }),
    enabled: !!selectedTournamentId && !!token,
    staleTime: 30000,
  });
  const followedPlayerIds = (followsData?.follows ?? [])
    .filter(f => f.playerId != null)
    .map(f => f.playerId as number);
  const followedGroupIds = (followsData?.follows ?? [])
    .filter(f => f.teeTimeId != null)
    .map(f => f.teeTimeId as number);

  // Fire sponsor impression events when leaderboard loads on mobile
  useEffect(() => {
    if (!leaderboard?.sponsors?.length || !leaderboard.tournamentId) return;
    const sid = `mobile_${leaderboard.tournamentId}_${Date.now().toString(36)}`;
    for (const sp of leaderboard.sponsors) {
      fetch(`${BASE_URL}/api/public/sponsor-events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sponsorId: sp.id,
          eventType: "impression",
          source: "mobile",
          sessionId: sid,
          tournamentId: leaderboard.tournamentId,
        }),
      }).catch(() => {});
    }
  // Run once per tournament change when leaderboard first loads
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaderboard?.tournamentId, leaderboard?.sponsors?.length]);

  // SSE connection for live leaderboard updates
  const lbSseRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!selectedTournamentId) return;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const ctrl = new AbortController();
    lbSseRef.current = ctrl;

    async function connect() {
      try {
        const res = await fetch(`${BASE_URL}/api/public/tournaments/${selectedTournamentId}/leaderboard/stream`, {
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const dataLine = part.split("\n").find(l => l.startsWith("data:"));
            if (!dataLine) continue;
            try {
              const parsed = JSON.parse(dataLine.slice(5).trim()) as {
                type: string;
                data?: {
                  entries?: LeaderboardEntry[];
                  netEntries?: LeaderboardEntry[];
                  stablefordEntries?: LeaderboardEntry[];
                  availableViews?: string[];
                  leaderboardType?: string | null;
                };
              };
              if (parsed.type === "leaderboard_update" && parsed.data) {
                queryClient.setQueryData<Leaderboard>(["leaderboard", selectedTournamentId], (old) => {
                  if (!old) return old;
                  const update: Partial<Leaderboard> = { lastUpdated: new Date().toISOString() };
                  if (parsed.data!.entries) update.entries = parsed.data!.entries;
                  if (parsed.data!.netEntries) update.netEntries = parsed.data!.netEntries;
                  if (parsed.data!.stablefordEntries) update.stablefordEntries = parsed.data!.stablefordEntries;
                  if (parsed.data!.availableViews) update.availableViews = parsed.data!.availableViews;
                  if (parsed.data!.leaderboardType !== undefined) update.leaderboardType = parsed.data!.leaderboardType;
                  return { ...old, ...update };
                });
              }
            } catch { /* ignore malformed events */ }
          }
        }
      } catch (e: unknown) {
        if ((e as { name?: string })?.name === "AbortError") return;
        // Retry on disconnect
        retryTimer = setTimeout(() => { if (!ctrl.signal.aborted) connect(); }, 8000);
      }
    }

    void connect();
    return () => {
      ctrl.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [selectedTournamentId, queryClient]);

  const uploadAsset = useCallback(async (asset: ImagePicker.ImagePickerAsset) => {
    const orgId = leaderboard?.organizationId;
    if (!orgId || !selectedTournamentId || !token) return;
    const mimeType = asset.mimeType ?? (asset.type === "video" ? "video/mp4" : "image/jpeg");
    const mediaType = mimeType.startsWith("video/") ? "video" : "image";
    if (mediaType === "video" && asset.duration && asset.duration > 60000) {
      alert(t('gallery.videoTooLong'));
      return;
    }
    if (asset.fileSize && asset.fileSize > 100 * 1024 * 1024) {
      alert(t('gallery.fileTooLarge'));
      return;
    }
    setGalleryUploading(true);
    try {
      const fileName = asset.uri.split("/").pop() ?? (mediaType === "video" ? "video.mp4" : "photo.jpg");
      const urlRes = await fetch(`${BASE_URL}/api/organizations/${orgId}/media/upload-url`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fileName, contentType: mimeType, tournamentId: selectedTournamentId }),
      });
      if (!urlRes.ok) {
        // Task #469 — propagate consent-required errors to the catch handler.
        const body = await urlRes.json().catch(() => ({} as { code?: string; consentRequired?: { message?: string } }));
        if (urlRes.status === 403 && body.code === "CONSENT_REQUIRED") {
          throw new Error(`__CONSENT__:${body.consentRequired?.message ?? "Consent required"}`);
        }
        throw new Error("Could not get upload URL");
      }
      const { uploadURL, objectPath, uploadToken } = await urlRes.json() as { uploadURL: string; objectPath: string; uploadToken: string };
      const blob = await fetch(asset.uri).then(r => r.blob());
      const putRes = await fetch(uploadURL, { method: "PUT", body: blob, headers: { "Content-Type": mimeType } });
      if (!putRes.ok) throw new Error("Upload failed");
      const regRes = await fetch(`${BASE_URL}/api/organizations/${orgId}/media`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ objectPath, uploadToken, caption: galleryCaption.trim() || null, mediaType, tournamentId: selectedTournamentId }),
      });
      if (!regRes.ok) throw new Error("Registration failed");
      setGalleryCaption("");
      await loadGallery(orgId);
      alert(mediaType === "video" ? t('gallery.uploadedVideo') : t('gallery.uploadedPhoto'));
    } catch (e: unknown) {
      const msg = (e as Error).message ?? t('gallery.uploadFailed');
      if (msg.startsWith("__CONSENT__:")) {
        // Task #469 / Task #620 — gallery uploads require photo or video consent.
        // On native we render the friendly ConsentPrompt component (matches
        // CaddieCard / Caddie Insights). Web targets keep the basic alert
        // because the in-screen modal isn't wired into the web layout.
        const consentMessage = msg.slice("__CONSENT__:".length);
        const category = mediaType === "video" ? "video" : "photo";
        if (Platform.OS === "web") {
          Alert.alert(
            "Consent required",
            consentMessage,
            [
              { text: "Cancel", style: "cancel" },
              { text: "Open Consent Settings", onPress: () => router.push("/my-360/consents") },
            ],
          );
        } else {
          setConsentPrompt({ message: consentMessage, category });
        }
      } else {
        alert(msg);
      }
    } finally {
      setGalleryUploading(false);
    }
  }, [selectedTournamentId, token, leaderboard?.organizationId, galleryCaption, loadGallery, t, router]);

  const deleteGalleryItem = useCallback(async (item: GalleryItem) => {
    const orgId = leaderboard?.organizationId;
    if (!orgId || !token) return;
    Alert.alert(t('gallery.deleteTitle'), t('gallery.deleteMessage'), [
      { text: t('gallery.cancel'), style: "cancel" },
      {
        text: t('gallery.deleteButton'), style: "destructive",
        onPress: async () => {
          const r = await fetch(`${BASE_URL}/api/organizations/${orgId}/media/${item.id}`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${token}` },
          });
          if (r.ok) await loadGallery(orgId);
          else alert(t('gallery.couldNotDelete'));
        },
      },
    ]);
  }, [leaderboard?.organizationId, token, loadGallery, t]);

  const pickAndUploadPhoto = useCallback(async () => {
    if (!selectedTournamentId || !token) return;
    Alert.alert(
      t('gallery.addToGallery'),
      t('gallery.chooseSource'),
      [
        {
          text: "📷 Camera",
          onPress: async () => {
            const perm = await ImagePicker.requestCameraPermissionsAsync();
            if (!perm.granted) { alert(t('gallery.cameraPermission')); return; }
            const result = await ImagePicker.launchCameraAsync({
              mediaTypes: ImagePicker.MediaTypeOptions.All,
              quality: 0.85,
              videoMaxDuration: 60,
            });
            if (!result.canceled && result.assets.length) await uploadAsset(result.assets[0]);
          },
        },
        {
          text: "🖼 Photo Library",
          onPress: async () => {
            const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (!perm.granted) { alert(t('gallery.mediaPermission')); return; }
            const result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ImagePicker.MediaTypeOptions.All,
              quality: 0.85,
              allowsEditing: false,
              videoMaxDuration: 60,
            });
            if (!result.canceled && result.assets.length) await uploadAsset(result.assets[0]);
          },
        },
        { text: t('gallery.cancel'), style: "cancel" },
      ]
    );
  }, [selectedTournamentId, token, uploadAsset, t]);

  // Load gallery when view switches to gallery tab
  useEffect(() => {
    if (view === "gallery" && selectedTournamentId) {
      loadGallery(leaderboard?.organizationId);
    }
  }, [view, selectedTournamentId, loadGallery, leaderboard?.organizationId]);

  interface TeeTimePlayer { playerId: number; firstName: string; lastName: string; flight: string | null; handicapIndex: string | null; }
  interface TeeTimeEntry { id: number; teeTime: string; hole: number; round: number; players: TeeTimePlayer[]; }
  const { data: teeTimes, isLoading: teeTimesLoading } = useQuery({
    queryKey: ["tee-times", selectedTournamentId],
    queryFn: () => fetchPublic<TeeTimeEntry[]>(`/tournaments/${selectedTournamentId}/tee-times`),
    enabled: !!selectedTournamentId && view === "tee-sheet",
  });

  const { data: announcements, isLoading: announcementsLoading, refetch: refetchAnnouncements } = useQuery({
    queryKey: ["public-announcements", selectedTournamentId],
    queryFn: () => fetchPublic<Announcement[]>(`/tournaments/${selectedTournamentId}/announcements`),
    enabled: !!selectedTournamentId && view === "announcements",
    refetchInterval: view === "announcements" ? 30000 : false,
  });

  interface TournamentDoc { documentId: number; title: string; category: string; visibility: string; filename: string | null; contentType: string | null; fileSize: number | null; }
  const { data: tournamentDocs, isLoading: tournamentDocsLoading } = useQuery({
    queryKey: ["public-tournament-docs", selectedTournamentId],
    queryFn: () => fetchPublic<TournamentDoc[]>(`/tournaments/${selectedTournamentId}/documents`),
    enabled: !!selectedTournamentId && view === "documents",
  });

  // Reset flight, round, view, and gallery/chat when tournament changes
  useEffect(() => {
    setActiveFlight("Overall");
    setSelectedRound(0);
    setView("leaderboard");
    setGalleryItems([]);
    setChatRoom(null);
  }, [selectedTournamentId]);

  // Reset flight when leaderboard data arrives
  useEffect(() => {
    if (leaderboard?.flights?.length && activeFlight !== "Overall") {
      if (!leaderboard.flights.includes(activeFlight)) setActiveFlight("Overall");
    }
  }, [leaderboard?.flights]);

  // Default the missed-cut group to collapsed whenever the visible list changes
  useEffect(() => {
    setCutSectionExpanded(false);
  }, [selectedTournamentId, activeFlight, mode, selectedRound]);

  // Load persisted mode when tournament changes
  useEffect(() => {
    if (!selectedTournamentId) return;
    AsyncStorage.getItem(`${modePersistKey}_${selectedTournamentId}`)
      .then(saved => {
        if (saved && ["gross", "net", "stableford"].includes(saved)) {
          setMode(saved as ScoreMode);
        }
      })
      .catch(() => {});
  }, [selectedTournamentId]);

  // Persist mode whenever it changes
  useEffect(() => {
    if (!selectedTournamentId) return;
    AsyncStorage.setItem(`${modePersistKey}_${selectedTournamentId}`, mode).catch(() => {});
  }, [mode, selectedTournamentId]);

  // Enforce leaderboard type: only change mode if current selection is not in availableViews
  useEffect(() => {
    const views: ScoreMode[] = (leaderboard?.availableViews?.filter(
      (v): v is ScoreMode => ["gross", "net", "stableford"].includes(v)
    )) ?? (
      leaderboard?.leaderboardType === 'net' ? ['net'] :
      leaderboard?.leaderboardType === 'stableford' ? ['stableford'] :
      leaderboard?.leaderboardType === 'gross' ? ['gross'] :
      ['gross', 'net']
    );
    setMode(prev => views.includes(prev) ? prev : (views[0] ?? 'gross'));
  }, [leaderboard?.availableViews?.join(","), leaderboard?.leaderboardType]);

  const displayEntries = (() => {
    if (!leaderboard) return [];
    let base: LeaderboardEntry[];
    if (activeFlight === "Overall") {
      if (mode === "net") base = leaderboard.netEntries;
      else if (mode === "stableford") base = leaderboard.stablefordEntries ?? [];
      else base = leaderboard.entries;
    } else if (mode === "net") {
      base = leaderboard.netEntries.filter(e => e.flight === activeFlight);
    } else if (mode === "stableford") {
      base = (leaderboard.stablefordEntries ?? []).filter(e => e.flight === activeFlight);
    } else {
      base = leaderboard.byFlight[activeFlight] ?? [];
    }
    // When a specific round is selected, overlay per-round scores from roundScores
    if (selectedRound > 0) {
      return base
        .map(e => {
          const rs = e.roundScores?.find(r => r.round === selectedRound);
          return {
            ...e,
            grossScore: rs?.grossScore ?? null,
            netScore: rs?.netScore ?? null,
            scoreToPar: rs?.scoreToPar ?? null,
            netToPar: rs && rs.netScore !== null ? rs.netScore - (leaderboard.coursePar) : null,
            holeScores: e.holeScores.filter(h => h.round === selectedRound),
            thru: rs ? (rs.isComplete ? "F" : `${rs.holesPlayed}`) : "-",
          };
        })
        .sort((a, b) => {
          const aScore = mode === "stableford" ? -(a.stablefordPoints ?? 0) : mode === "net" ? (a.netScore ?? 9999) : (a.grossScore ?? 9999);
          const bScore = mode === "stableford" ? -(b.stablefordPoints ?? 0) : mode === "net" ? (b.netScore ?? 9999) : (b.grossScore ?? 9999);
          if (aScore === 9999 && bScore === 9999) return 0;
          return aScore - bScore;
        })
        .map((e, i) => ({ ...e, position: i + 1, positionDisplay: `${i + 1}` }));
    }
    return base;
  })();

  const allFlights = leaderboard
    ? ["Overall", ...leaderboard.flights.filter(f => f !== "Overall")]
    : ["Overall"];

  // Task #2234 — pre-warm the userId → public-handle cache for every
  // tappable name on screen so the *first* tap on any leaderboard row
  // (singles or team-format member rows) opens the public profile (or
  // the private fallback) without a centred spinner. We collect ids
  // from both the flat leaderboard entries AND from team-format member
  // lists because both surface tappable names that funnel into the
  // same /member/[userId] resolver.
  const leaderboardUserIds = React.useMemo(() => {
    if (!leaderboard) return [] as number[];
    const ids: number[] = [];
    for (const e of leaderboard.entries ?? []) {
      if (typeof e.userId === "number") ids.push(e.userId);
    }
    for (const e of leaderboard.netEntries ?? []) {
      if (typeof e.userId === "number") ids.push(e.userId);
    }
    for (const e of leaderboard.stablefordEntries ?? []) {
      if (typeof e.userId === "number") ids.push(e.userId);
    }
    for (const team of leaderboard.teamEntries ?? []) {
      for (const m of team.members ?? []) {
        if (typeof m.userId === "number") ids.push(m.userId);
      }
    }
    return ids;
  }, [leaderboard]);
  usePrewarmPublicProfileHandles(leaderboardUserIds);

  const selectedTournament = tournaments?.find(t => t.id === selectedTournamentId);

  return (
    <View style={[styles.container, { paddingTop: topPadding }]}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>KHARA<Text style={{ color: '#C9A84C' }}>GOLF</Text></Text>
          <Text style={styles.headerTitle}>
            {view === "tee-sheet" ? t('header.teeSheet') : view === "announcements" ? t('header.updates') : view === "gallery" ? t('header.gallery') : view === "chat" ? t('header.chat') : view === "documents" ? t('header.documents') : t('header.leaderboard')}
          </Text>
        </View>
        <View style={styles.logoContainer}>
          <Image source={require('../../assets/logo.png')} style={styles.logoImage} resizeMode="contain" />
          {view === "leaderboard" && (
            <View style={styles.liveIndicator}>
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>LIVE</Text>
            </View>
          )}
        </View>
      </View>

      {/* ── Compete Hub Segment Control ─────────────────────────────── */}
      <View style={{ flexDirection: 'row', marginHorizontal: 16, marginBottom: 8, backgroundColor: '#1a2c22', borderRadius: 12, padding: 4, gap: 2 }}>
        {(["tournaments", "leagues", "rankings"] as CompeteSegment[]).map(seg => (
          <Pressable
            key={seg}
            onPress={() => setActiveSegment(seg)}
            style={{
              flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center',
              backgroundColor: activeSegment === seg ? GOLD : 'transparent',
            }}
          >
            <Text style={{ fontSize: 12, fontFamily: 'Inter_600SemiBold', color: activeSegment === seg ? '#000' : '#94b4a4', textTransform: 'capitalize' }}>
              {seg === "tournaments" ? t('segments.tournaments') : seg === "leagues" ? t('segments.leagues') : t('segments.rankings')}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* ── Leagues segment ─────────────────────────────────────────── */}
      {activeSegment === "leagues" && (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 120, gap: 12 }}>
          {!token && (
            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
              <Text style={{ fontSize: 15, color: '#94b4a4', fontFamily: 'Inter_500Medium', textAlign: 'center' }}>{t('leagues.signInToView')}</Text>
            </View>
          )}
          {token && (!myLeagues || myLeagues.length === 0) && (
            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
              <Text style={{ fontSize: 15, color: '#94b4a4', fontFamily: 'Inter_500Medium', textAlign: 'center' }}>{t('leagues.noLeagues')}</Text>
              <Pressable onPress={() => setActiveSegment("tournaments")} style={{ marginTop: 12, backgroundColor: GOLD + '20', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10, borderWidth: 1, borderColor: GOLD + '40' }}>
                <Text style={{ color: GOLD, fontFamily: 'Inter_600SemiBold', fontSize: 14 }}>{t('leagues.browseTournaments')}</Text>
              </Pressable>
            </View>
          )}
          {(myLeagues ?? []).map(l => (
            <Pressable
              key={l.leagueId}
              onPress={() => router.push('/(tabs)/leagues')}
              style={{ backgroundColor: '#1a2c22', borderRadius: 14, borderWidth: 1, borderColor: '#243b2e', padding: 16 }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: (LEAGUE_STATUS_COLOR[l.leagueStatus] ?? '#94b4a4') + '22' }}>
                      <Text style={{ fontSize: 10, color: LEAGUE_STATUS_COLOR[l.leagueStatus] ?? '#94b4a4', fontFamily: 'Inter_600SemiBold', textTransform: 'uppercase', letterSpacing: 1 }}>
                        {l.leagueStatus}
                      </Text>
                    </View>
                    {l.leagueFormat && (
                      <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: '#243b2e' }}>
                        <Text style={{ fontSize: 10, color: '#94b4a4', fontFamily: 'Inter_500Medium' }}>{l.leagueFormat}</Text>
                      </View>
                    )}
                  </View>
                  <Text style={{ fontSize: 16, color: '#e8f5ee', fontFamily: 'Inter_700Bold', marginBottom: 4 }}>{l.leagueName}</Text>
                  {(l.seasonStart || l.seasonEnd) && (
                    <Text style={{ fontSize: 12, color: '#94b4a4', fontFamily: 'Inter_400Regular' }}>
                      {fmtShortDate(l.seasonStart)} – {fmtShortDate(l.seasonEnd)}
                    </Text>
                  )}
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  {l.position != null && (
                    <View>
                      <Text style={{ fontSize: 10, color: '#4b7060', fontFamily: 'Inter_500Medium', textAlign: 'right' }}>{t('rank')}</Text>
                      <Text style={{ fontSize: 22, color: GOLD, fontFamily: 'Inter_700Bold', textAlign: 'right' }}>#{l.position}</Text>
                    </View>
                  )}
                  {l.roundsPlayed != null && (
                    <Text style={{ fontSize: 11, color: '#94b4a4', fontFamily: 'Inter_400Regular' }}>{l.roundsPlayed} {t('rounds')}</Text>
                  )}
                  <Ionicons name="chevron-forward" size={16} color="#4b7060" />
                </View>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {/* ── Rankings segment ─────────────────────────────────────────── */}
      {activeSegment === "rankings" && (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 120 }}>
          <View style={{ backgroundColor: '#1a2c22', borderRadius: 14, borderWidth: 1, borderColor: '#243b2e', padding: 16, marginBottom: 16 }}>
            <Text style={{ fontSize: 11, color: '#4b7060', letterSpacing: 1.5, fontFamily: 'Inter_600SemiBold', textTransform: 'uppercase', marginBottom: 8 }}>{t('rankings.title')}</Text>
            <Text style={{ fontSize: 13, color: '#94b4a4', fontFamily: 'Inter_400Regular', lineHeight: 20 }}>
              {t('rankings.description')}
            </Text>
          </View>
          {!token && (
            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
              <Text style={{ fontSize: 15, color: '#94b4a4', fontFamily: 'Inter_500Medium', textAlign: 'center' }}>{t('rankings.signInToView')}</Text>
            </View>
          )}
          {token && rankingHistory && rankingHistory.length > 0 && (
            <View style={{ backgroundColor: '#1a2c22', borderRadius: 14, borderWidth: 1, borderColor: '#243b2e', overflow: 'hidden' }}>
              <View style={{ paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#243b2e' }}>
                <Text style={{ fontSize: 13, color: '#e8f5ee', fontFamily: 'Inter_600SemiBold' }}>{t('rankings.myHistory')}</Text>
              </View>
              {[...rankingHistory].reverse().map((r, i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: i < rankingHistory.length - 1 ? 1 : 0, borderBottomColor: '#243b2e' }}>
                  <Text style={{ flex: 1, fontSize: 12, color: '#94b4a4', fontFamily: 'Inter_400Regular' }}>
                    {r.recordedAt ? new Date(r.recordedAt).toLocaleDateString(getLocale(), { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                  </Text>
                  <Text style={{ fontSize: 18, color: i === 0 ? GOLD : '#e8f5ee', fontFamily: i === 0 ? 'Inter_700Bold' : 'Inter_500Medium' }}>
                    {Number(r.handicapIndex).toFixed(1)}
                  </Text>
                  {i === 0 && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#22c55e', marginLeft: 8 }} />}
                </View>
              ))}
            </View>
          )}
          {token && (!rankingHistory || rankingHistory.length === 0) && (
            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
              <Text style={{ fontSize: 15, color: '#94b4a4', fontFamily: 'Inter_500Medium', textAlign: 'center' }}>{t('rankings.noHistory')}</Text>
            </View>
          )}
        </ScrollView>
      )}

      {/* ── Tournaments segment ──────────────────────────────────────── */}
      {activeSegment === "tournaments" && (
        <>
      {/* Tournament Picker Row — picker button + optional mode toggle */}
      <View style={styles.tournamentPickerRow}>
        <Pressable
          style={styles.tournamentPickerBtn}
          onPress={() => setTournamentPickerVisible(true)}
          accessibilityRole="button"
          accessibilityLabel="Select tournament"
        >
          <Ionicons name="golf" size={14} color={Colors.primary} />
          <Text
            style={[styles.tournamentPickerBtnText, !selectedTournament && styles.tournamentPickerBtnPlaceholder]}
            numberOfLines={1}
          >
            {selectedTournament ? selectedTournament.name : t('selectTournament')}
          </Text>
          {selectedTournament && (
            <View style={[styles.tStatusBadge, { borderColor: getTournamentStatusColor(selectedTournament.status) + "60", backgroundColor: getTournamentStatusColor(selectedTournament.status) + "20" }]}>
              <Text style={[styles.tStatusBadgeText, { color: getTournamentStatusColor(selectedTournament.status) }]}>
                {selectedTournament.status.charAt(0).toUpperCase() + selectedTournament.status.slice(1)}
              </Text>
            </View>
          )}
          <Feather name="chevron-down" size={15} color={Colors.muted} />
        </Pressable>
        {selectedTournament && (() => {
          const views: ScoreMode[] = (leaderboard?.availableViews?.filter(
            (v): v is ScoreMode => ["gross", "net", "stableford"].includes(v)
          )) ?? (
            leaderboard?.leaderboardType === 'gross' ? ['gross'] :
            leaderboard?.leaderboardType === 'net' ? ['net'] :
            leaderboard?.leaderboardType === 'stableford' ? ['stableford'] :
            ['gross', 'net']
          );
          if (views.length <= 1) return null;
          return (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginRight: 16 }}
              contentContainerStyle={styles.modeToggle}
            >
              {views.map(m => (
                <Pressable
                  key={m}
                  onPress={() => setMode(m)}
                  style={[styles.modeBtn, mode === m && (m === "stableford" ? styles.modeBtnStableford : styles.modeBtnActive)]}
                >
                  <Text style={[styles.modeBtnText, mode === m && (m === "stableford" ? styles.modeBtnTextStableford : styles.modeBtnTextActive)]}>
                    {m === "gross" ? t('scoreMode.gross') : m === "net" ? t('scoreMode.net') : t('scoreMode.stableford')}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          );
        })()}
      </View>

      {/* View Tabs — 4 fixed-width tabs, no horizontal scroll needed */}
      {selectedTournamentId && (
        <View style={styles.fixedViewTabs}>
          {/* Scores / Leaderboard */}
          <Pressable
            style={[styles.fixedViewTab, view === "leaderboard" && styles.fixedViewTabActive]}
            onPress={() => setView("leaderboard")}
            accessibilityRole="tab"
            accessibilityLabel={t('header.leaderboard')}
            accessibilityState={{ selected: view === "leaderboard" }}
          >
            <Text style={[styles.fixedViewTabText, view === "leaderboard" && styles.fixedViewTabTextActive]}>{t('header.leaderboard')}</Text>
          </Pressable>

          {/* Tee Sheet */}
          <Pressable
            style={[styles.fixedViewTab, view === "tee-sheet" && styles.fixedViewTabActive]}
            onPress={() => setView("tee-sheet")}
            accessibilityRole="tab"
            accessibilityLabel={t('header.teeSheet')}
            accessibilityState={{ selected: view === "tee-sheet" }}
          >
            <Text style={[styles.fixedViewTabText, view === "tee-sheet" && styles.fixedViewTabTextActive]}>{t('header.teeSheet')}</Text>
          </Pressable>

          {/* Chat */}
          <Pressable
            style={[styles.fixedViewTab, view === "chat" && styles.fixedViewTabActive]}
            onPress={() => setView("chat")}
            accessibilityRole="tab"
            accessibilityLabel={t('header.chat')}
            accessibilityState={{ selected: view === "chat" }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Text style={[styles.fixedViewTabText, view === "chat" && styles.fixedViewTabTextActive]}>{t('header.chat')}</Text>
              {unreadChatCount > 0 && (
                <View style={styles.chatUnreadBadge}>
                  <Text style={styles.chatUnreadText}>{unreadChatCount > 99 ? "99+" : unreadChatCount}</Text>
                </View>
              )}
            </View>
          </Pressable>

          {/* More — opens modal for Tracker, Updates, Gallery, Documents */}
          <Pressable
            style={[styles.fixedViewTab, (view === "tracker" || view === "announcements" || view === "gallery" || view === "documents") && styles.fixedViewTabActive]}
            onPress={() => setMoreViewsVisible(true)}
          >
            <Text style={[styles.fixedViewTabText, (view === "tracker" || view === "announcements" || view === "gallery" || view === "documents") && styles.fixedViewTabTextActive]}>
              {view === "tracker" ? t('bottomNav.tracker') : view === "announcements" ? t('bottomNav.updates') : view === "gallery" ? t('bottomNav.gallery') : view === "documents" ? t('bottomNav.documents') : t('bottomNav.more')}
            </Text>
          </Pressable>
        </View>
      )}

      {/* FilterBar — Round + Flight consolidated into one non-scrolling row */}
      {view === "leaderboard" && leaderboard && selectedTournamentId && (
        (leaderboard.rounds ?? 1) > 1 || allFlights.length > 1
      ) && (
        <View style={styles.filterBar}>
          {(leaderboard.rounds ?? 1) > 1 && (
            <Pressable style={styles.filterPill} onPress={() => setRoundPickerVisible(true)}>
              <Text style={styles.filterPillLabel}>{t('leaderboard:roundLabel')}</Text>
              <Text style={styles.filterPillValue}>{selectedRound === 0 ? "Overall" : `R${selectedRound}`}</Text>
              <Feather name="chevron-down" size={11} color={Colors.muted} />
            </Pressable>
          )}
          {allFlights.length > 1 && (
            <Pressable style={styles.filterPill} onPress={() => setFlightPickerVisible(true)}>
              <Text style={styles.filterPillLabel}>{t('leaderboard:flightLabel')}</Text>
              <Text style={styles.filterPillValue}>{activeFlight}</Text>
              <Feather name="chevron-down" size={11} color={Colors.muted} />
            </Pressable>
          )}
        </View>
      )}

      {/* Empty state — no tournament selected */}
      {!selectedTournamentId && (
        <View style={styles.emptyState}>
          <Text style={{ fontSize: 52, marginBottom: 16 }}>🏆</Text>
          <Text style={styles.emptyTitle}>{t('leaderboard:chooseTournament')}</Text>
          <Text style={styles.emptySubtitle}>{t('leaderboard:chooseTournamentSubtitle')}</Text>
          <Pressable style={styles.pickTournamentCta} onPress={() => setTournamentPickerVisible(true)}>
            <Ionicons name="golf" size={15} color="#000" />
            <Text style={styles.pickTournamentCtaText}>{t('leaderboard:selectTournamentBtn')}</Text>
          </Pressable>
        </View>
      )}

      {/* Column headers — leaderboard view only */}
      {view === "leaderboard" && selectedTournamentId && (
        <LiveOddsWidget tournamentId={selectedTournamentId} surface="mobile_leaderboard" />
      )}

      {view === "leaderboard" && !isLoading && displayEntries.length > 0 && (
        <View style={styles.columnHeaders}>
          <Text style={[styles.colHeader, { width: 40, textAlign: "center" }]}>POS</Text>
          <Text style={[styles.colHeader, { flex: 1 }]}>PLAYER</Text>
          <Text style={[styles.colHeader, { width: 36, textAlign: "center" }]}>THRU</Text>
          <Text style={[styles.colHeader, { width: 44, textAlign: "center" }]}>TOT</Text>
          <Text style={[styles.colHeader, { width: 52, textAlign: "center" }]}>+/-</Text>
        </View>
      )}

      {/* Tracker View */}
      {view === "tracker" && (
        isLoading ? (
          <View style={styles.loadingContainer}>
            <LoadingSpinner size="large" color={Colors.primary} />
            <Text style={styles.loadingText}>{t('leaderboard:loadingTracker')}</Text>
          </View>
        ) : !displayEntries.length ? (
          <View style={styles.emptyState}>
            <Feather name="grid" size={48} color={Colors.muted} />
            <Text style={styles.emptyTitle}>{t('leaderboard:noScoresTitle')}</Text>
            <Text style={styles.emptySubtitle}>{t('leaderboard:noScoresSubtitle')}</Text>
          </View>
        ) : (
          <TrackerView entries={displayEntries} selectedRound={selectedRound} bottomPad={isWeb ? 34 : insets.bottom + 100} />
        )
      )}

      {/* Announcements View */}
      {view === "announcements" && (
        announcementsLoading ? (
          <View style={styles.loadingContainer}>
            <LoadingSpinner size="large" color={Colors.primary} />
            <Text style={styles.loadingText}>{t('leaderboard:loadingUpdates')}</Text>
          </View>
        ) : !announcements?.length ? (
          <View style={styles.emptyState}>
            <Feather name="bell" size={48} color={Colors.muted} />
            <Text style={styles.emptyTitle}>{t('leaderboard:noUpdatesTitle')}</Text>
            <Text style={styles.emptySubtitle}>{t('leaderboard:noUpdatesSubtitle')}</Text>
          </View>
        ) : (
          <FlatList
            data={announcements}
            keyExtractor={(item) => String(item.id)}
            contentContainerStyle={[styles.listContent, { paddingBottom: isWeb ? 34 : insets.bottom + 100 }]}
            showsVerticalScrollIndicator={false}
            refreshControl={<RefreshControl refreshing={false} onRefresh={refetchAnnouncements} tintColor={Colors.primary} colors={[Colors.primary]} />}
            renderItem={({ item }) => {
              const typeColors: Record<string, string> = {
                general: Colors.primary,
                delay: "#f59e0b",
                rule: "#8b5cf6",
                results: Colors.birdie ?? "#22c55e",
              };
              const color = typeColors[item.type] ?? Colors.primary;
              return (
                <View style={styles.announcementCard}>
                  <View style={[styles.announcementTypeBadge, { backgroundColor: color + "20", borderColor: color + "50" }]}>
                    <Text style={[styles.announcementTypeText, { color }]}>
                      {item.type.charAt(0).toUpperCase() + item.type.slice(1)}
                    </Text>
                  </View>
                  <Text style={styles.announcementBody}>{item.body}</Text>
                  <Text style={styles.announcementMeta}>
                    {item.authorName ? `${item.authorName} · ` : ""}
                    {new Date(item.sentAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </Text>
                </View>
              );
            }}
          />
        )
      )}

      {/* Documents View */}
      {view === "documents" && (
        tournamentDocsLoading ? (
          <View style={styles.loadingContainer}>
            <LoadingSpinner size="large" color={Colors.primary} />
            <Text style={styles.loadingText}>{t('leaderboard:loadingDocuments')}</Text>
          </View>
        ) : !tournamentDocs?.length ? (
          <View style={styles.emptyState}>
            <Feather name="file-text" size={48} color={Colors.muted} />
            <Text style={styles.emptyTitle}>{t('leaderboard:noDocumentsTitle')}</Text>
            <Text style={styles.emptySubtitle}>{t('leaderboard:noDocumentsSubtitle')}</Text>
          </View>
        ) : (
          <FlatList
            data={tournamentDocs}
            keyExtractor={(item) => String(item.documentId)}
            contentContainerStyle={[styles.listContent, { paddingBottom: isWeb ? 34 : insets.bottom + 100 }]}
            showsVerticalScrollIndicator={false}
            renderItem={({ item }) => (
              <Pressable
                style={styles.announcementCard}
                onPress={() => Linking.openURL(`${BASE_URL}/api/public/tournaments/${selectedTournamentId}/documents/${item.documentId}`)}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                  <Feather name="file-text" size={22} color={Colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.announcementBody, { fontWeight: "600", marginBottom: 2 }]}>{item.title}</Text>
                    <Text style={styles.announcementMeta}>
                      {item.category.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
                      {item.filename ? ` · ${item.filename}` : ""}
                    </Text>
                  </View>
                  <Feather name="download" size={18} color={Colors.muted} />
                </View>
              </Pressable>
            )}
          />
        )
      )}

      {/* Gallery View */}
      {view === "gallery" && (
        <View style={{ flex: 1 }}>
          {/* Upload panel — only shown when authenticated and org is known */}
          {token && leaderboard?.organizationId ? (
            <View style={styles.galleryUploadPanel}>
              <TextInput
                style={styles.galleryUploadInput}
                value={galleryCaption}
                onChangeText={setGalleryCaption}
                placeholder={t('gallery.addCaption')}
                placeholderTextColor="#6b7280"
              />
              <Pressable
                style={[styles.galleryUploadBtn, galleryUploading && { opacity: 0.6 }]}
                onPress={pickAndUploadPhoto}
                disabled={galleryUploading}
              >
                {galleryUploading
                  ? <LoadingSpinner size="small" color="#fff" />
                  : <Text style={styles.galleryUploadBtnText}>📷 Upload Photo</Text>
                }
              </Pressable>
            </View>
          ) : null}

          {galleryLoading ? (
            <View style={styles.loadingContainer}>
              <LoadingSpinner size="large" color="#a855f7" />
              <Text style={styles.loadingText}>{t('leaderboard:loadingGallery')}</Text>
            </View>
          ) : galleryItems.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={{ fontSize: 40, marginBottom: 12 }}>📷</Text>
              <Text style={styles.emptyTitle}>{t('leaderboard:noPhotosTitle')}</Text>
              <Text style={styles.emptySubtitle}>{t('leaderboard:noPhotosSubtitle')}</Text>
            </View>
          ) : (
            <>
              <FlatList
                data={galleryItems}
                keyExtractor={item => String(item.id)}
                numColumns={2}
                contentContainerStyle={[styles.galleryGrid, { paddingBottom: isWeb ? 34 : insets.bottom + 100 }]}
                showsVerticalScrollIndicator={false}
                renderItem={({ item }) => {
                  const isMyUpload = token && user?.id != null && item.uploadedByUserId === user.id;
                  const isVideo = item.mediaType === "video";
                  const thumbUri = isVideo && item.thumbnailPath
                    ? `${BASE_URL}/api/storage${item.thumbnailPath}`
                    : `${BASE_URL}/api/storage${item.objectPath}`;
                  return (
                    <Pressable style={styles.galleryCell} onPress={() => setLightboxItem(item)}>
                      <Image source={{ uri: thumbUri }} style={styles.galleryImage} resizeMode="cover" />
                      {isVideo && (
                        <View style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center" }}>
                          <View style={{ backgroundColor: "rgba(0,0,0,0.52)", borderRadius: 24, width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
                            <Text style={{ color: "#fff", fontSize: 18, lineHeight: 20 }}>▶</Text>
                          </View>
                        </View>
                      )}
                      {!item.approved && (
                        <View style={{ position: "absolute", top: 6, right: 6, backgroundColor: "rgba(234,179,8,0.8)", borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 }}>
                          <Text style={{ color: "#fff", fontSize: 10 }}>{t('leaderboard:pending')}</Text>
                        </View>
                      )}
                      {isMyUpload && (
                        <Pressable
                          onPress={() => deleteGalleryItem(item)}
                          style={{ position: "absolute", bottom: 6, right: 6, backgroundColor: "rgba(239,68,68,0.8)", borderRadius: 14, width: 28, height: 28, alignItems: "center", justifyContent: "center" }}
                          hitSlop={10}
                        >
                          <Text style={{ color: "#fff", fontSize: 14, lineHeight: 16 }}>🗑</Text>
                        </Pressable>
                      )}
                      {item.caption ? (
                        <View style={styles.galleryCaptionBar}>
                          <Text style={styles.galleryCaptionText} numberOfLines={1}>{item.caption}</Text>
                        </View>
                      ) : null}
                    </Pressable>
                  );
                }}
              />
              {/* Lightbox — image OR full-screen video player */}
              {lightboxItem && (
                <Modal visible animationType="fade" transparent onRequestClose={() => setLightboxItem(null)}>
                  <View style={styles.lightboxBackdrop}>
                    <Pressable style={{ position: "absolute", top: 16, right: 16, zIndex: 10, backgroundColor: "rgba(0,0,0,0.5)", borderRadius: 20, padding: 8 }} onPress={() => setLightboxItem(null)}>
                      <Text style={{ color: "#fff", fontSize: 18 }}>✕</Text>
                    </Pressable>
                    {lightboxItem.mediaType === "video" ? (
                      <Video
                        source={{ uri: `${BASE_URL}/api/storage${lightboxItem.objectPath}` }}
                        style={styles.lightboxImage}
                        resizeMode={ResizeMode.CONTAIN}
                        useNativeControls
                        shouldPlay
                      />
                    ) : (
                      <Pressable style={{ flex: 1, width: "100%" }} onPress={() => setLightboxItem(null)}>
                        <Image source={{ uri: `${BASE_URL}/api/storage${lightboxItem.objectPath}` }} style={styles.lightboxImage} resizeMode="contain" />
                      </Pressable>
                    )}
                    {lightboxItem.caption ? (
                      <View style={styles.lightboxCaption}>
                        <Text style={styles.lightboxCaptionText}>{lightboxItem.caption}</Text>
                        {lightboxItem.uploaderName ? <Text style={styles.lightboxUploader}>by {lightboxItem.uploaderName}</Text> : null}
                      </View>
                    ) : null}
                  </View>
                </Modal>
              )}
            </>
          )}
        </View>
      )}

      {/* Chat View */}
      {view === "chat" && (
        chatLoading ? (
          <View style={styles.loadingContainer}>
            <LoadingSpinner size="large" color="#06b6d4" />
            <Text style={styles.loadingText}>{t('leaderboard:loadingChat')}</Text>
          </View>
        ) : !token ? (
          <View style={styles.emptyState}>
            <Text style={{ fontSize: 40, marginBottom: 12 }}>🔒</Text>
            <Text style={styles.emptyTitle}>{t('leaderboard:signInRequired')}</Text>
            <Text style={styles.emptySubtitle}>{t('leaderboard:signInToViewChat')}</Text>
          </View>
        ) : !chatRoom?.enabled ? (
          <View style={styles.emptyState}>
            <Text style={{ fontSize: 40, marginBottom: 12 }}>💬</Text>
            <Text style={styles.emptyTitle}>{t('leaderboard:chatNotAvailable')}</Text>
            <Text style={styles.emptySubtitle}>{t('leaderboard:chatNotAvailableSubtitle')}</Text>
          </View>
        ) : (
          <View style={{ flex: 1 }}>
            <FlatList
              data={chatRoom.messages}
              keyExtractor={item => String(item.id)}
              contentContainerStyle={[styles.chatList, { paddingBottom: isWeb ? 34 : insets.bottom + 80 }]}
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={
                <View style={{ alignItems: "center", paddingTop: 48 }}>
                  <Text style={styles.emptySubtitle}>{t('leaderboard:noMessagesYet')}</Text>
                </View>
              }
              renderItem={({ item }) => (
                <View style={[styles.chatBubble, item.isPinned && styles.chatBubblePinned]}>
                  <View style={styles.chatBubbleHeader}>
                    <Text style={styles.chatDisplayName}>{item.displayName}</Text>
                    {item.isPinned && <Text style={styles.chatPinnedBadge}>📌 pinned</Text>}
                    <Text style={styles.chatTime}>
                      {new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </Text>
                  </View>
                  {item.messageType === "gallery-share" && (item.mediaThumbnailPath || item.mediaObjectPath) && (
                    <Image
                      source={{ uri: `${BASE_URL}/api/storage${item.mediaThumbnailPath ?? item.mediaObjectPath}` }}
                      style={{ width: "100%", height: 120, borderRadius: 6, marginBottom: 4 }}
                      resizeMode="cover"
                    />
                  )}
                  <Text style={styles.chatBody}>{item.body}</Text>
                </View>
              )}
            />
            {token ? (
              <View>
                <View style={styles.emojiStrip}>
                  {QUICK_EMOJIS.map(e => (
                    <Pressable key={e} onPress={() => setChatInput(prev => prev + e)} style={styles.emojiBtn} hitSlop={4}>
                      <Text style={styles.emojiText}>{e}</Text>
                    </Pressable>
                  ))}
                </View>
                <View style={[styles.chatInputRow, { paddingBottom: isWeb ? 12 : insets.bottom + 8 }]}>
                  <TextInput
                    style={styles.chatInput}
                    value={chatInput}
                    onChangeText={setChatInput}
                    placeholder={t('leaderboard:typeMessage')}
                    placeholderTextColor={Colors.muted}
                    returnKeyType="send"
                    onSubmitEditing={sendChatMessage}
                    editable={!chatSending}
                    maxLength={500}
                  />
                  <Pressable
                    style={[styles.chatSendBtn, (!chatInput.trim() || chatSending) && { opacity: 0.4 }]}
                    onPress={sendChatMessage}
                    disabled={!chatInput.trim() || chatSending}
                  >
                    {chatSending
                      ? <LoadingSpinner size="small" color="#fff" />
                      : <Feather name="send" size={16} color="#fff" />
                    }
                  </Pressable>
                </View>
              </View>
            ) : (
              <View style={[styles.chatLoginBanner, { paddingBottom: isWeb ? 12 : insets.bottom + 8 }]}>
                <Text style={styles.chatLoginText}>{t('leaderboard:logInToSend')}</Text>
              </View>
            )}
          </View>
        )
      )}

      {/* Tee Sheet + Leaderboard Views */}
      {(view === "leaderboard" || view === "tee-sheet") && (view === "tee-sheet" ? (
        teeTimesLoading ? (
          <View style={styles.loadingContainer}>
            <LoadingSpinner size="large" color={Colors.primary} />
            <Text style={styles.loadingText}>{t('leaderboard:loadingTeeSheet')}</Text>
          </View>
        ) : !teeTimes?.length ? (
          <View style={styles.emptyState}>
            <Feather name="clock" size={48} color={Colors.muted} />
            <Text style={styles.emptyTitle}>{t('leaderboard:noTeeTimes')}</Text>
            <Text style={styles.emptySubtitle}>{t('leaderboard:noTeeTimesSubtitle')}</Text>
          </View>
        ) : (
          <FlatList
            data={teeTimes}
            keyExtractor={(item) => String(item.id)}
            contentContainerStyle={[styles.listContent, { paddingBottom: isWeb ? 34 : insets.bottom + 100 }]}
            showsVerticalScrollIndicator={false}
            ListHeaderComponent={
              <View style={styles.teeSheetHeader}>
                <Text style={[styles.colHeader, { flex: 1 }]}>{t('leaderboard:teeSheetTimeCol')}</Text>
                <Text style={[styles.colHeader, { width: 48, textAlign: "center" }]}>{t('leaderboard:teeSheetHoleCol')}</Text>
                <Text style={[styles.colHeader, { flex: 2 }]}>{t('leaderboard:teeSheetPlayersCol')}</Text>
              </View>
            }
            renderItem={({ item: tt, index }) => (
              <View style={[styles.teeRow, index % 2 === 0 ? {} : { backgroundColor: Colors.surface }]}>
                <Text style={styles.teeTime}>{new Date(tt.teeTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Text>
                <View style={styles.teeHoleBadge}>
                  <Text style={styles.teeHoleText}>{tt.hole}</Text>
                </View>
                <View style={{ flex: 2 }}>
                  {tt.players.map((p) => (
                    <View key={p.playerId} style={styles.teePlayer}>
                      <Text style={styles.teePlayerName}>{p.firstName} {p.lastName}</Text>
                      {p.flight && <Text style={styles.teeFlight}>{p.flight}</Text>}
                      {p.handicapIndex != null && <Text style={styles.teeHcp}>{t('leaderboard:hcpLabel', { hcp: Number(p.handicapIndex).toFixed(1) })}</Text>}
                    </View>
                  ))}
                </View>
              </View>
            )}
          />
        )
      ) : (
        /* Main leaderboard list */
        isLoading ? (
          <View style={styles.loadingContainer}>
            <LoadingSpinner size="large" color={Colors.primary} />
            <Text style={styles.loadingText}>{t('leaderboard:loadingLeaderboard')}</Text>
          </View>
        ) : !selectedTournamentId ? null
        : displayEntries.length === 0 && !(leaderboard?.isTeamFormat && leaderboard.teamEntries?.length) ? (
          <View style={styles.emptyState}>
            <Feather name="bar-chart-2" size={48} color={Colors.muted} />
            <Text style={styles.emptyTitle}>{t('leaderboard:noScoresLeaderboard')}</Text>
            <Text style={styles.emptySubtitle}>{t('leaderboard:noScoresLeaderboardSubtitle')}</Text>
          </View>
        ) : leaderboard?.isTeamFormat && leaderboard.teamEntries && leaderboard.teamEntries.length > 0 ? (
          <FlatList
            data={leaderboard.teamEntries}
            keyExtractor={(item) => String(item.teamId)}
            contentContainerStyle={[styles.listContent, { paddingBottom: isWeb ? 34 : insets.bottom + 100 }]}
            refreshControl={<RefreshControl refreshing={isFetching && !isLoading} onRefresh={refetch} tintColor={Colors.primary} colors={[Colors.primary]} />}
            showsVerticalScrollIndicator={false}
            ListFooterComponent={leaderboard ? (
              <View>
                <Text style={styles.lastUpdated}>{t('leaderboard:updatedTeamFormat', { time: new Date(leaderboard.lastUpdated).toLocaleTimeString() })}</Text>
                {leaderboard.organizationId ? (
                  <InlineAdBanner
                    orgId={leaderboard.organizationId}
                    slotKey="mobile_leaderboard_footer"
                    tournamentId={leaderboard.tournamentId}
                    height={64}
                    style={{ marginTop: 8, marginHorizontal: 16, marginBottom: 4 }}
                  />
                ) : null}
              </View>
            ) : null}
            renderItem={({ item: team, index }) => {
              const isExpanded = expandedTeams.has(team.teamId);
              const toPar = team.scoreToPar;
              const toParStr = toPar === null ? "–" : toPar === 0 ? "E" : toPar > 0 ? `+${toPar}` : String(toPar);
              const toParColor = toPar === null ? Colors.muted : toPar < 0 ? "#ef4444" : toPar > 0 ? "#60a5fa" : Colors.textSecondary;
              return (
                <View>
                  <Pressable
                    onPress={() => setExpandedTeams(prev => { const next = new Set(prev); isExpanded ? next.delete(team.teamId) : next.add(team.teamId); return next; })}
                    style={[styles.row, index % 2 === 0 && styles.firstRow]}
                  >
                    <Text style={[styles.position, index === 0 && { color: "#f59e0b" }]}>{team.grossScore !== null ? team.positionDisplay : "–"}</Text>
                    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8 }}>
                      {team.teamColour ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: team.teamColour }} /> : null}
                      <View style={{ flex: 1 }}>
                        <Text style={styles.playerName} numberOfLines={1}>{team.teamName}</Text>
                        <Text style={{ fontSize: 11, color: Colors.muted }}>{t('leaderboard:playersCount', { count: team.members.length })} {isExpanded ? "▲" : "▼"}</Text>
                      </View>
                    </View>
                    <Text style={styles.thru}>{team.holesCompleted > 0 ? `T${team.holesCompleted}` : "–"}</Text>
                    <Text style={styles.grossScore}>{team.grossScore ?? "–"}</Text>
                    <View style={[styles.scoreToParBadge, { backgroundColor: `${toParColor}20` }]}>
                      <Text style={[styles.scoreToPar, { color: toParColor }]}>{toParStr}</Text>
                    </View>
                  </Pressable>
                  {isExpanded && (
                    <View style={{ backgroundColor: "rgba(0,0,0,0.25)", paddingHorizontal: 16, paddingVertical: 8 }}>
                      {team.members.map((m, mi) => {
                        // Task #1791 — tapping a teammate's name opens
                        // the public profile viewer (or private member
                        // fallback) for parity with the singles
                        // leaderboard rows wired up in Task #1457.
                        const goToProfile = () => {
                          if (m.userId == null) return;
                          router.push({
                            pathname: "/member/[userId]",
                            params: {
                              userId: String(m.userId),
                              displayName: m.playerName,
                            },
                          });
                        };
                        return (
                          <View key={m.playerId} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 4, borderTopWidth: mi > 0 ? 1 : 0, borderTopColor: "rgba(255,255,255,0.05)" }}>
                            {m.userId != null ? (
                              <Pressable
                                onPress={goToProfile}
                                hitSlop={6}
                                style={{ flex: 1 }}
                                accessibilityRole="link"
                                accessibilityLabel={`Open ${m.playerName}'s profile`}
                                testID={`team-member-name-${m.userId}`}
                              >
                                <Text style={{ fontSize: 13, color: Colors.text }}>{m.playerName}</Text>
                              </Pressable>
                            ) : (
                              <Text style={{ fontSize: 13, color: Colors.text, flex: 1 }}>{m.playerName}</Text>
                            )}
                            <Text style={{ fontSize: 11, color: Colors.muted, marginRight: 12 }}>{t('leaderboard:hcpLabel', { hcp: m.handicapIndex })}</Text>
                            <Text style={{ fontSize: 13, color: Colors.textSecondary, width: 40, textAlign: "right" }}>{m.grossScore ?? "–"}</Text>
                          </View>
                        );
                      })}
                    </View>
                  )}
                </View>
              );
            }}
          />
        ) : (
          <FlatList
            data={(() => {
              const survivors = displayEntries.filter(e => e.madeCut !== false);
              const cut = displayEntries.filter(e => e.madeCut === false);
              const items: Array<
                | { kind: "entry"; entry: LeaderboardEntry; index: number }
                | { kind: "cutHeader"; count: number }
              > = survivors.map((entry, i) => ({ kind: "entry" as const, entry, index: i }));
              if (cut.length > 0) {
                items.push({ kind: "cutHeader" as const, count: cut.length });
                if (cutSectionExpanded) {
                  cut.forEach((entry, i) =>
                    items.push({ kind: "entry" as const, entry, index: survivors.length + i })
                  );
                }
              }
              return items;
            })()}
            keyExtractor={(item) =>
              item.kind === "entry" ? `e-${item.entry.playerId}` : "cut-header"
            }
            ListHeaderComponent={
              <SpectatorFeedSection
                events={notableData?.events ?? []}
                groups={paceData?.groups ?? []}
                followedPlayerIds={followedPlayerIds}
                followedGroupIds={followedGroupIds}
                hasToken={!!token}
                onManageFollows={() => router.push({ pathname: "/spectator-follows", params: { tournamentId: String(selectedTournamentId) } })}
              />
            }
            renderItem={({ item }) => {
              if (item.kind === "cutHeader") {
                return (
                  <Pressable
                    onPress={() => setCutSectionExpanded(v => !v)}
                    style={styles.cutSectionHeader}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: cutSectionExpanded }}
                    accessibilityLabel={`${t('leaderboard:missedCutHeader')}, ${t('leaderboard:missedCutCount', { count: item.count })}`}
                    testID="cut-section-toggle"
                  >
                    <Text style={styles.cutSectionTitle}>{t('leaderboard:missedCutHeader')}</Text>
                    <Text style={styles.cutSectionCount}>— {t('leaderboard:missedCutCount', { count: item.count })}</Text>
                    <Text style={styles.cutSectionChevron}>{cutSectionExpanded ? "▾" : "▸"}</Text>
                  </Pressable>
                );
              }
              return (
                <LeaderboardRow
                  entry={item.entry}
                  mode={mode}
                  format={leaderboard?.format}
                  index={item.index}
                  onPress={() => setSelectedEntry(item.entry)}
                  // Task #1457 — tapping the player name in the
                  // leaderboard navigates into the profile router
                  // (/member/[userId]), which redirects to the public
                  // profile viewer when a handle is reserved.
                  onProfilePress={(e) => {
                    if (e.userId == null) return;
                    router.push({
                      pathname: "/member/[userId]",
                      params: {
                        userId: String(e.userId),
                        displayName: e.playerName,
                        avatar: e.profileImage ?? "",
                      },
                    });
                  }}
                  currentUserId={user?.id ?? null}
                  isFollowing={item.entry.userId != null && followeeIdSet.has(item.entry.userId)}
                  showFollow={!!token}
                />
              );
            }}
            contentContainerStyle={[styles.listContent, { paddingBottom: isWeb ? 34 : insets.bottom + 100 }]}
            refreshControl={
              <RefreshControl refreshing={isFetching && !isLoading} onRefresh={refetch} tintColor={Colors.primary} colors={[Colors.primary]} />
            }
            showsVerticalScrollIndicator={false}
            ListFooterComponent={
              leaderboard ? (
                <View>
                  <Text style={styles.lastUpdated}>
                    {t('leaderboard:updatedTapPlayer', { time: new Date(leaderboard.lastUpdated).toLocaleTimeString() })}
                  </Text>
                  {leaderboard.organizationId ? (
                    <InlineAdBanner
                      orgId={leaderboard.organizationId}
                      slotKey="mobile_leaderboard_footer"
                      tournamentId={leaderboard.tournamentId}
                      height={64}
                      style={{ marginTop: 8, marginHorizontal: 16, marginBottom: 4 }}
                    />
                  ) : null}
                </View>
              ) : null
            }
          />
        )
      ))}

      {/* Scorecard modal */}
      {selectedEntry && (
        <ScorecardModal entry={selectedEntry} onClose={() => setSelectedEntry(null)} />
      )}

      {/* ── Tournament Picker Modal ──────────────────────────────────── */}
      <Modal
        visible={tournamentPickerVisible}
        animationType="slide"
        onRequestClose={() => setTournamentPickerVisible(false)}
      >
        <View style={styles.pickerModal}>
          <View style={styles.pickerModalHeader}>
            <Text style={styles.pickerModalTitle}>{t('leaderboard:chooseTournamentModal')}</Text>
            <Pressable onPress={() => setTournamentPickerVisible(false)} style={styles.pickerModalClose}>
              <Feather name="x" size={22} color={Colors.text} />
            </Pressable>
          </View>
          {!tournaments || tournaments.length === 0 ? (
            <View style={styles.pickerModalEmpty}>
              <Text style={{ fontSize: 48, marginBottom: 12 }}>🏆</Text>
              <Text style={styles.pickerModalEmptyText}>{t('leaderboard:noTournamentsAvailable')}</Text>
            </View>
          ) : (
            <FlatList
              data={tournaments}
              keyExtractor={t => String(t.id)}
              contentContainerStyle={{ padding: 16, paddingBottom: 60 }}
              ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
              renderItem={({ item: t }) => {
                const isSelected = selectedTournamentId === t.id;
                const statusColor = getTournamentStatusColor(t.status);
                return (
                  <Pressable
                    onPress={() => { setSelectedTournamentId(t.id); setTournamentPickerVisible(false); }}
                    style={[styles.pickerModalItem, isSelected && styles.pickerModalItemActive]}
                  >
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 }}>
                        <View style={[styles.tStatusBadge, { backgroundColor: statusColor + "25", borderColor: statusColor + "60" }]}>
                          <Text style={[styles.tStatusBadgeText, { color: statusColor }]}>
                            {t.status.charAt(0).toUpperCase() + t.status.slice(1)}
                          </Text>
                        </View>
                        {t.format ? (
                          <Text style={styles.pickerItemFormat}>{t.format}</Text>
                        ) : null}
                      </View>
                      <Text style={[styles.pickerItemName, isSelected && { color: GOLD }]}>{t.name}</Text>
                      {(t.startDate || t.endDate) && (
                        <Text style={styles.pickerItemDate}>
                          {t.startDate ? new Date(t.startDate).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : ""}
                          {t.startDate && t.endDate ? " – " : ""}
                          {t.endDate ? new Date(t.endDate).toLocaleDateString([], { day: "numeric", month: "short" }) : ""}
                        </Text>
                      )}
                      <Text style={styles.pickerItemOrg}>{t.organizationName}</Text>
                    </View>
                    {isSelected && <Ionicons name="checkmark-circle" size={22} color={GOLD} />}
                  </Pressable>
                );
              }}
            />
          )}
        </View>
      </Modal>

      {/* ── More Views Modal ─────────────────────────────────────────── */}
      <Modal
        visible={moreViewsVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setMoreViewsVisible(false)}
      >
        <Pressable style={styles.moreModalBackdrop} onPress={() => setMoreViewsVisible(false)}>
          <Pressable style={styles.moreModalSheet} onPress={e => e.stopPropagation()}>
            <View style={styles.modalHandle} />
            <Text style={styles.moreModalTitle}>{t('moreViews')}</Text>
            {([
              { value: "tracker" as const, icon: "⛳", label: t('viewOptions.trackerLabel'), desc: t('viewOptions.trackerDesc') },
              { value: "announcements" as const, icon: "📢", label: t('viewOptions.updatesLabel'), desc: t('viewOptions.updatesDesc') },
              { value: "gallery" as const, icon: "📷", label: t('viewOptions.galleryLabel'), desc: t('viewOptions.galleryDesc') },
              { value: "documents" as const, icon: "📄", label: t('viewOptions.documentsLabel'), desc: t('viewOptions.documentsDesc') },
            ]).map(item => (
              <Pressable
                key={item.value}
                style={[styles.moreModalItem, view === item.value && styles.moreModalItemActive]}
                onPress={() => { setView(item.value); setMoreViewsVisible(false); }}
              >
                <Text style={{ fontSize: 24 }}>{item.icon}</Text>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={[styles.moreModalItemLabel, view === item.value && { color: GOLD }]}>{item.label}</Text>
                  <Text style={styles.moreModalItemDesc}>{item.desc}</Text>
                </View>
                {view === item.value && <Ionicons name="checkmark-circle" size={20} color={GOLD} />}
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── Round Picker Modal ───────────────────────────────────────── */}
      {leaderboard && (leaderboard.rounds ?? 1) > 1 && (
        <Modal
          visible={roundPickerVisible}
          animationType="slide"
          transparent
          onRequestClose={() => setRoundPickerVisible(false)}
        >
          <Pressable style={styles.moreModalBackdrop} onPress={() => setRoundPickerVisible(false)}>
            <Pressable style={styles.moreModalSheet} onPress={e => e.stopPropagation()}>
              <View style={styles.modalHandle} />
              <Text style={styles.moreModalTitle}>{t('selectRound')}</Text>
              {[{ label: t('overall'), value: 0 }, ...Array.from({ length: leaderboard.rounds }, (_, i) => ({ label: t('round', { n: i + 1 }), value: i + 1 }))].map(r => (
                <Pressable
                  key={r.value}
                  style={[styles.moreModalItem, selectedRound === r.value && styles.moreModalItemActive]}
                  onPress={() => { setSelectedRound(r.value); setRoundPickerVisible(false); }}
                >
                  <Text style={[styles.moreModalItemLabel, selectedRound === r.value && { color: GOLD }]}>{r.label}</Text>
                  {selectedRound === r.value && <Ionicons name="checkmark-circle" size={20} color={GOLD} />}
                </Pressable>
              ))}
            </Pressable>
          </Pressable>
        </Modal>
      )}

      {/* ── Flight Picker Modal ──────────────────────────────────────── */}
      {allFlights.length > 1 && (
        <Modal
          visible={flightPickerVisible}
          animationType="slide"
          transparent
          onRequestClose={() => setFlightPickerVisible(false)}
        >
          <Pressable style={styles.moreModalBackdrop} onPress={() => setFlightPickerVisible(false)}>
            <Pressable style={styles.moreModalSheet} onPress={e => e.stopPropagation()}>
              <View style={styles.modalHandle} />
              <Text style={styles.moreModalTitle}>{t('selectFlight')}</Text>
              {allFlights.map(f => (
                <Pressable
                  key={f}
                  style={[styles.moreModalItem, activeFlight === f && styles.moreModalItemActive]}
                  onPress={() => { setActiveFlight(f); setFlightPickerVisible(false); }}
                >
                  <Text style={[styles.moreModalItemLabel, activeFlight === f && { color: GOLD }]}>{f}</Text>
                  {activeFlight === f && <Ionicons name="checkmark-circle" size={20} color={GOLD} />}
                </Pressable>
              ))}
            </Pressable>
          </Pressable>
        </Modal>
      )}
        </>
      )}

      {/* Task #620 — friendly consent prompt for blocked photo/video uploads. */}
      {consentPrompt && (
        <Modal visible animationType="fade" transparent onRequestClose={() => setConsentPrompt(null)}>
          <Pressable style={styles.consentBackdrop} onPress={() => setConsentPrompt(null)}>
            <Pressable onPress={(e) => e.stopPropagation()}>
              <ConsentPrompt
                message={consentPrompt.message}
                category={consentPrompt.category}
                onDismiss={() => setConsentPrompt(null)}
              />
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

// ─── Spectator Feed Section (notable moments + pace/tee-off countdown) ───────

interface SpectatorFeedSectionProps {
  events: NotableEvent[];
  groups: PaceGroup[];
  followedPlayerIds: number[];
  followedGroupIds: number[];
  hasToken: boolean;
  onManageFollows: () => void;
}

function SpectatorFeedSection({ events, groups, followedPlayerIds, followedGroupIds, hasToken, onManageFollows }: SpectatorFeedSectionProps) {
  const { t } = useTranslation('leaderboard');
  const upcoming = groups
    .filter(g => g.status !== "complete")
    .slice()
    .sort((a, b) => {
      const af = followedGroupIds.includes(a.teeTimeId) ? 0 : 1;
      const bf = followedGroupIds.includes(b.teeTimeId) ? 0 : 1;
      if (af !== bf) return af - bf;
      return new Date(a.teeTime).getTime() - new Date(b.teeTime).getTime();
    })
    .slice(0, 3);

  const recentEvents = events.slice(0, 8);

  if (upcoming.length === 0 && recentEvents.length === 0) return null;

  return (
    <View style={spectatorStyles.container}>
      {upcoming.length > 0 && (
        <View style={spectatorStyles.section}>
          <View style={spectatorStyles.sectionHeader}>
            <Feather name="clock" size={13} color={Colors.primary} />
            <Text style={spectatorStyles.sectionTitle}>{t('spectatorFeed.paceTitle')}</Text>
            {hasToken && (
              <Pressable onPress={onManageFollows} hitSlop={8} style={{ marginLeft: "auto" }}>
                <Text style={spectatorStyles.manageLink}>{t('spectatorFeed.manage')}</Text>
              </Pressable>
            )}
          </View>
          {upcoming.map(g => {
            const followed = followedGroupIds.includes(g.teeTimeId);
            const teeStr = new Date(g.teeTime).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" });
            let label: string;
            if (g.status === "in_progress") label = t('spectatorFeed.onHole', { hole: g.currentHole ?? "?" });
            else if (g.minutesUntilTeeOff > 0) label = t('spectatorFeed.teesOffIn', { count: g.minutesUntilTeeOff });
            else if (g.minutesUntilTeeOff > -5) label = t('spectatorFeed.teeingOffNow');
            else label = t('spectatorFeed.teeTimeAt', { time: teeStr });
            const statusColor =
              g.status === "in_progress" ? Colors.primary
              : g.status === "upcoming" ? "#C9A84C"
              : Colors.muted;
            return (
              <View
                key={g.teeTimeId}
                style={[
                  spectatorStyles.paceCard,
                  followed && { borderColor: "#C9A84C66", backgroundColor: "rgba(201,168,76,0.06)" },
                ]}
              >
                <View style={[spectatorStyles.statusPill, { backgroundColor: statusColor + "20", borderColor: statusColor + "55" }]}>
                  <Text style={[spectatorStyles.statusPillText, { color: statusColor }]} numberOfLines={1}>{label}</Text>
                </View>
                <Text style={spectatorStyles.paceNames} numberOfLines={1}>
                  {g.players.map(p => p.name).join(", ")}
                </Text>
                <Text style={spectatorStyles.paceMeta}>R{g.round} · {teeStr}</Text>
              </View>
            );
          })}
        </View>
      )}

      {recentEvents.length > 0 && (
        <View style={spectatorStyles.section}>
          <View style={spectatorStyles.sectionHeader}>
            <Feather name="activity" size={13} color="#C9A84C" />
            <Text style={[spectatorStyles.sectionTitle, { color: "#C9A84C" }]}>{t('spectatorFeed.notableTitle')}</Text>
            {hasToken && upcoming.length === 0 && (
              <Pressable onPress={onManageFollows} hitSlop={8} style={{ marginLeft: "auto" }}>
                <Text style={spectatorStyles.manageLink}>{t('spectatorFeed.manage')}</Text>
              </Pressable>
            )}
          </View>
          {recentEvents.map((ev, i) => {
            const icon =
              ev.eventType === "hole_in_one" ? "⛳" :
              ev.eventType === "eagle" ? "🦅" :
              ev.eventType === "birdie" ? "🐦" :
              ev.eventType === "round_finish" ? "🏁" :
              ev.eventType === "round_start" ? "🟢" : "•";
            const label =
              ev.eventType === "hole_in_one" ? t('spectatorFeed.events.holeInOne') :
              ev.eventType === "eagle" ? t('spectatorFeed.events.eagle') :
              ev.eventType === "birdie" ? t('spectatorFeed.events.birdie') :
              ev.eventType === "round_finish" ? t('spectatorFeed.events.roundFinish') :
              ev.eventType === "round_start" ? t('spectatorFeed.events.roundStart') : t('spectatorFeed.events.teeOff');
            const time = new Date(ev.occurredAt).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" });
            const followed = ev.playerId != null && followedPlayerIds.includes(ev.playerId);
            return (
              <View
                key={i}
                style={[
                  spectatorStyles.eventRow,
                  followed && { borderColor: "#C9A84C66", backgroundColor: "rgba(201,168,76,0.06)" },
                ]}
              >
                <Text style={spectatorStyles.eventIcon}>{icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={spectatorStyles.eventText} numberOfLines={1}>
                    <Text style={{ color: Colors.text, fontFamily: "Inter_600SemiBold" }}>{ev.playerName}</Text>
                    <Text style={{ color: Colors.muted }}> — {label}</Text>
                    {ev.eventType !== "round_start" && ev.eventType !== "round_finish" && (
                      <Text style={{ color: Colors.muted }}> · {t('spectatorFeed.holeShort', { hole: ev.holeNumber })}</Text>
                    )}
                  </Text>
                </View>
                <Text style={spectatorStyles.eventTime}>{time}</Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

const spectatorStyles = StyleSheet.create({
  container: { paddingHorizontal: 12, paddingTop: 8, gap: 10 },
  section: { gap: 6 },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
  sectionTitle: {
    fontFamily: "Inter_700Bold", fontSize: 11, color: Colors.primary,
    letterSpacing: 1, textTransform: "uppercase",
  },
  manageLink: { fontFamily: "Inter_600SemiBold", fontSize: 11, color: "#C9A84C" },
  paceCard: {
    flexDirection: "row", alignItems: "center", gap: 8,
    borderWidth: 1, borderColor: Colors.border, borderRadius: 12,
    paddingHorizontal: 10, paddingVertical: 8,
    backgroundColor: Colors.card,
  },
  statusPill: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999,
    borderWidth: 1, maxWidth: 140,
  },
  statusPillText: { fontFamily: "Inter_700Bold", fontSize: 10 },
  paceNames: { flex: 1, fontFamily: "Inter_500Medium", fontSize: 12, color: Colors.textSecondary },
  paceMeta: { fontFamily: "Inter_400Regular", fontSize: 10, color: Colors.muted },
  eventRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 10, paddingVertical: 7,
    borderRadius: 10, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.card,
  },
  eventIcon: { fontSize: 16 },
  eventText: { fontFamily: "Inter_400Regular", fontSize: 12 },
  eventTime: { fontFamily: "Inter_400Regular", fontSize: 10, color: Colors.muted, fontVariant: ["tabular-nums"] },
});

// ─── Hole-by-Hole Tracker View ────────────────────────────────────────────────

const NAME_W = 120;
const HOLE_W = 32;
const THRU_W = 36;
const TOT_W = 44;

function holeScoreBg(toPar: number): string {
  if (toPar <= -2) return "#C9A84C";   // eagle+: gold
  if (toPar === -1) return "#ef4444";  // birdie: red
  if (toPar === 0)  return Colors.surface; // par: neutral
  if (toPar === 1)  return "#3b82f6";  // bogey: blue
  return "#8b5cf6";                    // double+: purple
}

function holeScoreTextColor(toPar: number): string {
  if (toPar === 0) return Colors.textSecondary;
  return "#fff";
}

interface TrackerViewProps {
  entries: LeaderboardEntry[];
  selectedRound: number;
  bottomPad: number;
}

function TrackerView({ entries, selectedRound, bottomPad }: TrackerViewProps) {
  const masterScrollRef = useRef<ScrollView>(null);
  const rowScrollRefs = useRef<(ScrollView | null)[]>([]);

  const syncScroll = useCallback((x: number, sourceIdx: number) => {
    masterScrollRef.current?.scrollTo({ x, animated: false });
    rowScrollRefs.current.forEach((ref, i) => {
      if (i !== sourceIdx) ref?.scrollTo({ x, animated: false });
    });
  }, []);

  const holes = Array.from({ length: 18 }, (_, i) => i + 1);

  return (
    <View style={{ flex: 1 }}>
      {/* Sticky header row */}
      <View style={trackerStyles.headerRow}>
        <View style={{ width: NAME_W, justifyContent: "center" }}>
          <Text style={trackerStyles.headerText}>PLAYER</Text>
        </View>
        <View style={{ width: THRU_W, justifyContent: "center", alignItems: "center" }}>
          <Text style={trackerStyles.headerText}>THRU</Text>
        </View>
        <ScrollView
          horizontal
          ref={masterScrollRef}
          scrollEnabled={false}
          showsHorizontalScrollIndicator={false}
        >
          {holes.map(h => (
            <View key={h} style={{ width: HOLE_W, alignItems: "center", justifyContent: "center" }}>
              <Text style={[trackerStyles.headerText, h === 10 ? { color: Colors.secondary } : null]}>{h}</Text>
            </View>
          ))}
          <View style={{ width: TOT_W, alignItems: "center", justifyContent: "center" }}>
            <Text style={trackerStyles.headerText}>TOT</Text>
          </View>
        </ScrollView>
      </View>
      {/* Player rows */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: bottomPad }}
        showsVerticalScrollIndicator={false}
      >
        {entries.map((entry, idx) => {
          const roundHoles = selectedRound > 0
            ? entry.holeScores.filter(h => h.round === selectedRound)
            : entry.holeScores.filter(h => h.round === (entry.currentRound ?? 1));
          const scoreByHole: Record<number, HoleScore> = {};
          for (const h of roundHoles) scoreByHole[h.hole] = h;
          const holesPlayed = entry.holesCompleted ?? roundHoles.length;
          const totalToPar = roundHoles.reduce((s, h) => s + h.toPar, 0);
          const currentlyOn = entry.currentHole;

          return (
            <View key={entry.playerId} style={[trackerStyles.playerRow, idx % 2 === 0 ? {} : { backgroundColor: Colors.surface }]}>
              {/* Name cell */}
              <View style={{ width: NAME_W, flexShrink: 0 }}>
                <Text style={trackerStyles.playerName} numberOfLines={1}>{entry.playerName}</Text>
              </View>
              {/* Thru cell */}
              <View style={{ width: THRU_W, alignItems: "center", justifyContent: "center" }}>
                <Text style={trackerStyles.thruText}>{entry.thru}</Text>
              </View>
              {/* Hole score cells */}
              <ScrollView
                horizontal
                ref={ref => { rowScrollRefs.current[idx] = ref; }}
                scrollEventThrottle={16}
                onScroll={e => syncScroll(e.nativeEvent.contentOffset.x, idx)}
                showsHorizontalScrollIndicator={false}
              >
                {holes.map(h => {
                  const hs = scoreByHole[h];
                  const isCurrentHole = h === currentlyOn && !hs;
                  if (isCurrentHole) {
                    return (
                      <View key={h} style={[trackerStyles.holeCell, { backgroundColor: Colors.primary + "30" }]}>
                        <View style={[trackerStyles.currentDot]} />
                      </View>
                    );
                  }
                  if (!hs) {
                    return (
                      <View key={h} style={trackerStyles.holeCell}>
                        <Text style={trackerStyles.emptyCell}>—</Text>
                      </View>
                    );
                  }
                  return (
                    <View key={h} style={[trackerStyles.holeCell, { backgroundColor: holeScoreBg(hs.toPar) }]}>
                      <Text style={[trackerStyles.holeScore, { color: holeScoreTextColor(hs.toPar) }]}>{hs.strokes}</Text>
                    </View>
                  );
                })}
                {/* Total cell */}
                <View style={[trackerStyles.totalCell, { backgroundColor: Colors.card }]}>
                  <Text style={[trackerStyles.totalScore, {
                    color: totalToPar < 0 ? "#ef4444" : totalToPar > 0 ? "#94a3b8" : Colors.textSecondary
                  }]}>
                    {holesPlayed === 0 ? "—" : totalToPar === 0 ? "E" : totalToPar > 0 ? `+${totalToPar}` : String(totalToPar)}
                  </Text>
                </View>
              </ScrollView>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const trackerStyles = StyleSheet.create({
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  headerText: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    color: Colors.textSecondary,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  playerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 4,
    paddingVertical: 0,
    minHeight: 40,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border + "40",
  },
  playerName: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: Colors.text,
  },
  thruText: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: Colors.textSecondary,
  },
  holeCell: {
    width: HOLE_W,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  holeScore: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
  },
  emptyCell: {
    fontSize: 11,
    color: Colors.muted,
  },
  currentDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.primary,
  },
  totalCell: {
    width: TOT_W,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderLeftWidth: 1,
    borderLeftColor: Colors.border,
  },
  totalScore: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
  },
});

// ──────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
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
  brand: { fontFamily: "Inter_700Bold", fontSize: 10, color: Colors.text, letterSpacing: 3, marginBottom: 2 },
  headerTitle: { fontFamily: "Inter_700Bold", fontSize: 24, color: Colors.text },
  logoContainer: { alignItems: "center", gap: 6 },
  logoImage: { width: 36, height: 36, marginBottom: 4 },
  liveIndicator: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: Colors.primary + "20", paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 20, borderWidth: 1, borderColor: Colors.primary + "40",
  },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: Colors.primary },
  liveText: { fontFamily: "Inter_700Bold", fontSize: 11, color: Colors.primary, letterSpacing: 1 },
  pickerContainer: { padding: 12, gap: 8 },
  pickerChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border, maxWidth: 180 },
  pickerChipActive: { backgroundColor: Colors.primary + "25", borderColor: Colors.primary + "60" },
  pickerChipText: { fontFamily: "Inter_500Medium", fontSize: 13, color: Colors.textSecondary },
  pickerChipTextActive: { color: Colors.primary },
  tournamentBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  bannerLeft: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1 },
  tournamentBannerText: { fontFamily: "Inter_500Medium", fontSize: 13, color: Colors.textSecondary, flex: 1 },
  modeToggle: { flexDirection: "row", gap: 2, backgroundColor: Colors.card, borderRadius: 8, padding: 2 },
  modeBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  modeBtnActive: { backgroundColor: Colors.primary + "30" },
  modeBtnStableford: { backgroundColor: "rgba(52,211,153,0.2)" },
  modeBtnText: { fontFamily: "Inter_500Medium", fontSize: 12, color: Colors.muted },
  modeBtnTextActive: { color: Colors.primary },
  modeBtnTextStableford: { color: "#34d399", fontFamily: "Inter_600SemiBold" as const },
  flightTabsContainer: { padding: 10, gap: 6 },
  flightTab: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16,
    backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border,
  },
  flightTabActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  flightTabText: { fontFamily: "Inter_600SemiBold", fontSize: 12, color: Colors.textSecondary },
  flightTabTextActive: { color: "#000" },
  columnHeaders: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  colHeader: { fontFamily: "Inter_600SemiBold", fontSize: 10, color: Colors.muted, letterSpacing: 0.5 },
  listContent: { },
  row: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: Colors.border + "60", gap: 4,
  },
  firstRow: { backgroundColor: Colors.secondary + "08" },
  position: { width: 40, textAlign: "center", fontSize: 14 },
  playerInfo: { flex: 1, paddingRight: 8 },
  playerNameRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  playerName: { fontFamily: "Inter_600SemiBold", fontSize: 15, color: Colors.text, flex: 1 },
  verifiedBadge: {
    backgroundColor: Colors.primary + "20", borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1,
    borderWidth: 1, borderColor: Colors.primary + "30",
  },
  verifiedText: { fontFamily: "Inter_700Bold", fontSize: 9, color: Colors.primary },
  flight: { fontFamily: "Inter_400Regular", fontSize: 11, color: Colors.muted, marginTop: 1 },
  thru: { width: 36, textAlign: "center", fontFamily: "Inter_400Regular", fontSize: 14, color: Colors.textSecondary },
  grossScore: { width: 44, textAlign: "center", fontFamily: "Inter_700Bold", fontSize: 16, color: Colors.text },
  scoreToParBadge: { width: 52, borderRadius: 8, paddingVertical: 4, alignItems: "center" },
  scoreToPar: { fontFamily: "Inter_700Bold", fontSize: 14 },
  loadingContainer: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loadingText: { fontFamily: "Inter_400Regular", fontSize: 14, color: Colors.textSecondary },
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 12 },
  emptyTitle: { fontFamily: "Inter_600SemiBold", fontSize: 20, color: Colors.text },
  emptySubtitle: { fontFamily: "Inter_400Regular", fontSize: 14, color: Colors.textSecondary, textAlign: "center" },
  lastUpdated: { textAlign: "center", fontFamily: "Inter_400Regular", fontSize: 11, color: Colors.muted, paddingVertical: 12 },
  cutSectionHeader: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: "#0d1a15",
    borderTopWidth: 1, borderBottomWidth: 1, borderColor: "#243b2e",
  },
  cutSectionTitle: { fontFamily: "Inter_700Bold", fontSize: 11, color: "rgba(255,255,255,0.65)", letterSpacing: 2, textTransform: "uppercase" },
  cutSectionCount: { fontFamily: "Inter_400Regular", fontSize: 11, color: "rgba(255,255,255,0.45)" },
  cutSectionChevron: { marginLeft: "auto", fontSize: 12, color: "rgba(255,255,255,0.45)" },
  rowMissedCut: { opacity: 0.55 },
  textMuted: { color: "rgba(255,255,255,0.35)" },
  mcBadge: { backgroundColor: "rgba(239,68,68,0.2)", borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1, marginLeft: 5, borderWidth: 1, borderColor: "rgba(239,68,68,0.4)" },
  mcBadgeText: { fontFamily: "Inter_700Bold", fontSize: 9, color: "rgba(239,68,68,0.9)", letterSpacing: 0.5 },
  // Scorecard modal
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  modalSheet: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    maxHeight: "85%", paddingHorizontal: 16, paddingBottom: 32,
    borderTopWidth: 1, borderColor: Colors.border,
  },
  modalHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: Colors.border, alignSelf: "center", marginVertical: 12 },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: Colors.border },
  modalName: { fontFamily: "Inter_700Bold", fontSize: 18, color: Colors.text },
  modalSub: { fontFamily: "Inter_400Regular", fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  modalClose: { padding: 4 },
  modalEmpty: { padding: 32, alignItems: "center" },
  modalEmptyText: { fontFamily: "Inter_400Regular", fontSize: 14, color: Colors.muted },
  statsRow: { flexDirection: "row", paddingVertical: 12, marginBottom: 8, borderBottomWidth: 1, borderBottomColor: Colors.border },
  statCell: { flex: 1, alignItems: "center", gap: 2 },
  statIcon: { fontSize: 16 },
  statValue: { fontFamily: "Inter_700Bold", fontSize: 18, color: Colors.text },
  statLabel: { fontFamily: "Inter_400Regular", fontSize: 10, color: Colors.muted },
  scorecardHeader: {
    flexDirection: "row", paddingVertical: 8, paddingHorizontal: 4,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  scColHead: { fontFamily: "Inter_600SemiBold", fontSize: 10, color: Colors.muted, letterSpacing: 0.5 },
  scRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: Colors.border + "50" },
  scCell: { fontFamily: "Inter_400Regular", fontSize: 14, color: Colors.textSecondary },
  scoreCircle: { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  eagleCircle: { backgroundColor: Colors.eagle + "25", borderWidth: 1, borderColor: Colors.eagle },
  birdieCircle: { backgroundColor: Colors.birdie + "20", borderRadius: 4 },
  bogeyCircle: { borderWidth: 1, borderColor: Colors.bogey + "60" },
  doubleCircle: { borderWidth: 2, borderColor: Colors.doubleOrWorse + "60" },
  teeSheetBtn: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8,
    backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border,
  },
  teeSheetBtnActive: { backgroundColor: Colors.primary + "25", borderColor: Colors.primary + "60" },
  teeSheetBtnText: { fontFamily: "Inter_500Medium", fontSize: 12, color: Colors.textSecondary },
  teeSheetBtnTextActive: { color: Colors.primary },
  teeSheetHeader: {
    flexDirection: "row", paddingHorizontal: 16, paddingVertical: 8,
    backgroundColor: Colors.surface, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  teeRow: {
    flexDirection: "row", alignItems: "flex-start", paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: Colors.border + "60", gap: 8,
  },
  teeTime: { flex: 1, fontFamily: "Inter_700Bold", fontSize: 14, color: Colors.text, paddingTop: 2 },
  teeHoleBadge: {
    width: 48, height: 24, borderRadius: 12,
    backgroundColor: Colors.primary + "20", borderWidth: 1, borderColor: Colors.primary + "40",
    alignItems: "center", justifyContent: "center",
  },
  teeHoleText: { fontFamily: "Inter_700Bold", fontSize: 12, color: Colors.primary },
  teePlayer: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 3 },
  teePlayerName: { fontFamily: "Inter_600SemiBold", fontSize: 13, color: Colors.text, flex: 1 },
  teeFlight: {
    fontFamily: "Inter_500Medium", fontSize: 10, color: Colors.primary,
    backgroundColor: Colors.primary + "15", paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4,
  },
  teeHcp: { fontFamily: "Inter_400Regular", fontSize: 10, color: Colors.muted },
  scoreCircleText: { fontFamily: "Inter_700Bold", fontSize: 13 },
  totalRow: { backgroundColor: Colors.card, borderRadius: 8, marginTop: 4 },
  viewTabs: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  viewTab: {
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  viewTabActive: { borderBottomColor: Colors.primary },
  viewTabText: { fontFamily: "Inter_500Medium", fontSize: 13, color: Colors.muted },
  viewTabTextActive: { color: Colors.primary, fontFamily: "Inter_600SemiBold" },
  announcementCard: {
    marginHorizontal: 16, marginVertical: 6, padding: 14,
    backgroundColor: Colors.card, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border,
    gap: 6,
  },
  announcementTypeBadge: {
    alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 8, borderWidth: 1,
  },
  announcementTypeText: { fontFamily: "Inter_700Bold", fontSize: 11, letterSpacing: 0.5 },
  announcementBody: { fontFamily: "Inter_400Regular", fontSize: 14, color: Colors.text, lineHeight: 20 },
  announcementMeta: { fontFamily: "Inter_400Regular", fontSize: 11, color: Colors.muted },
  // View tabs scroll
  viewTabsScroll: { borderBottomWidth: 1, borderBottomColor: Colors.border, backgroundColor: Colors.surface, flexShrink: 0, flexGrow: 0 },
  viewTabsContainer: { flexDirection: "row", paddingHorizontal: 4 },
  viewTabActiveGallery: { borderBottomColor: "#a855f7" },
  viewTabActiveChat: { borderBottomColor: "#06b6d4" },
  viewTabActiveTracker: { borderBottomColor: Colors.secondary },
  viewTabTextGallery: { color: "#a855f7", fontFamily: "Inter_600SemiBold" },
  viewTabTextChat: { color: "#06b6d4", fontFamily: "Inter_600SemiBold" },
  viewTabTextTracker: { color: Colors.secondary, fontFamily: "Inter_600SemiBold" },
  // Gallery
  galleryUploadPanel: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderColor: "rgba(168,85,247,0.2)",
    backgroundColor: "rgba(168,85,247,0.05)",
  },
  galleryUploadInput: {
    flex: 1, height: 36, borderRadius: 8, paddingHorizontal: 10,
    backgroundColor: "rgba(255,255,255,0.07)", color: "#fff",
    fontFamily: "Inter_400Regular", fontSize: 13,
    borderWidth: 1, borderColor: "rgba(168,85,247,0.3)",
  },
  galleryUploadBtn: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8,
    backgroundColor: "#a855f7", alignItems: "center", justifyContent: "center",
  },
  galleryUploadBtnText: { color: "#fff", fontFamily: "Inter_600SemiBold", fontSize: 13 },
  galleryGrid: { padding: 8, gap: 8 },
  galleryCell: {
    flex: 1, margin: 4, borderRadius: 10, overflow: "hidden",
    backgroundColor: Colors.card, aspectRatio: 1,
  },
  galleryImage: { width: "100%", height: "100%" },
  galleryCaptionBar: {
    position: "absolute", bottom: 0, left: 0, right: 0,
    backgroundColor: "rgba(0,0,0,0.6)", paddingHorizontal: 8, paddingVertical: 4,
  },
  galleryCaptionText: { fontFamily: "Inter_400Regular", fontSize: 11, color: "#fff" },
  lightboxBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.92)",
    alignItems: "center", justifyContent: "center",
  },
  lightboxImage: {
    width: Dimensions.get("window").width,
    height: Dimensions.get("window").height * 0.75,
  },
  lightboxCaption: { paddingHorizontal: 24, paddingTop: 16, alignItems: "center" },
  lightboxCaptionText: { fontFamily: "Inter_600SemiBold", fontSize: 15, color: "#fff", textAlign: "center" },
  lightboxUploader: { fontFamily: "Inter_400Regular", fontSize: 12, color: Colors.muted, marginTop: 4 },
  // Chat
  chatList: { paddingHorizontal: 12, paddingTop: 12 },
  chatBubble: {
    backgroundColor: Colors.card, borderRadius: 12, padding: 12, marginBottom: 8,
    borderWidth: 1, borderColor: Colors.border,
  },
  chatBubblePinned: { borderColor: "#06b6d4" + "60", backgroundColor: "#06b6d4" + "08" },
  chatBubbleHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  chatDisplayName: { fontFamily: "Inter_600SemiBold", fontSize: 13, color: Colors.text, flex: 1 },
  chatPinnedBadge: { fontFamily: "Inter_400Regular", fontSize: 10, color: "#06b6d4" },
  chatTime: { fontFamily: "Inter_400Regular", fontSize: 11, color: Colors.muted },
  chatBody: { fontFamily: "Inter_400Regular", fontSize: 14, color: Colors.textSecondary, lineHeight: 20 },
  emojiStrip: {
    flexDirection: "row", paddingHorizontal: 12, paddingVertical: 6, gap: 8,
    borderTopWidth: 1, borderTopColor: Colors.border, backgroundColor: Colors.surface,
  },
  emojiBtn: { padding: 4 },
  emojiText: { fontSize: 22 },
  chatInputRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingTop: 8,
    borderTopWidth: 1, borderTopColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  chatInput: {
    flex: 1, backgroundColor: Colors.card, borderRadius: 22, paddingHorizontal: 16,
    paddingVertical: Platform.OS === "ios" ? 10 : 8, fontFamily: "Inter_400Regular",
    fontSize: 14, color: Colors.text, borderWidth: 1, borderColor: Colors.border,
  },
  chatSendBtn: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: "#06b6d4",
    alignItems: "center", justifyContent: "center",
  },
  chatLoginBanner: {
    paddingHorizontal: 16, paddingTop: 12,
    borderTopWidth: 1, borderTopColor: Colors.border,
    backgroundColor: Colors.surface, alignItems: "center",
  },
  chatLoginText: { fontFamily: "Inter_400Regular", fontSize: 13, color: Colors.muted },

  // ── New UX: Tournament Picker Button ────────────────────────────────
  tournamentPickerRow: {
    flexDirection: "row", alignItems: "center",
    borderBottomWidth: 1, borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  tournamentPickerBtn: {
    flex: 1, flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 16, paddingVertical: 10,
  },
  tournamentPickerBtnText: {
    flex: 1, fontFamily: "Inter_600SemiBold", fontSize: 14, color: Colors.text,
  },
  tournamentPickerBtnPlaceholder: { color: Colors.muted, fontFamily: "Inter_400Regular" },
  tStatusBadge: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, borderWidth: 1, flexShrink: 0,
  },
  tStatusBadgeText: { fontFamily: "Inter_600SemiBold", fontSize: 10, letterSpacing: 0.5 },

  // ── New UX: Fixed view tabs (4 equal columns, no scroll) ─────────────
  fixedViewTabs: {
    flexDirection: "row",
    borderBottomWidth: 1, borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  fixedViewTab: {
    flex: 1, alignItems: "center", justifyContent: "center",
    paddingVertical: 11,
    borderBottomWidth: 2, borderBottomColor: "transparent",
  },
  fixedViewTabActive: { borderBottomColor: GOLD },
  fixedViewTabText: { fontFamily: "Inter_500Medium", fontSize: 12, color: Colors.muted },
  fixedViewTabTextActive: { color: GOLD, fontFamily: "Inter_600SemiBold" },
  chatUnreadBadge: {
    backgroundColor: "#06b6d4", borderRadius: 8, minWidth: 16, height: 16,
    paddingHorizontal: 3, alignItems: "center", justifyContent: "center",
  },
  chatUnreadText: { color: "#fff", fontSize: 10, fontFamily: "Inter_700Bold", lineHeight: 12 },

  // ── New UX: FilterBar (consolidated round + flight) ──────────────────
  filterBar: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  filterPill: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20,
    backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border,
  },
  filterPillLabel: { fontFamily: "Inter_400Regular", fontSize: 12, color: Colors.muted },
  filterPillValue: { fontFamily: "Inter_600SemiBold", fontSize: 12, color: Colors.text },

  // ── New UX: Empty state CTA ──────────────────────────────────────────
  pickTournamentCta: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginTop: 20, backgroundColor: GOLD,
    paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12,
  },
  pickTournamentCtaText: { fontFamily: "Inter_700Bold", fontSize: 15, color: "#000" },

  // ── New UX: Tournament Picker Modal (full screen) ────────────────────
  pickerModal: {
    flex: 1, backgroundColor: Colors.background,
  },
  pickerModalHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 20, paddingTop: 60, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  pickerModalTitle: { fontFamily: "Inter_700Bold", fontSize: 20, color: Colors.text },
  pickerModalClose: { padding: 4 },
  pickerModalEmpty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  pickerModalEmptyText: { fontFamily: "Inter_500Medium", fontSize: 16, color: Colors.muted },
  pickerModalItem: {
    flexDirection: "row", alignItems: "center",
    backgroundColor: Colors.card, borderRadius: 14, padding: 16,
    borderWidth: 1, borderColor: Colors.border,
  },
  pickerModalItemActive: { borderColor: GOLD + "60", backgroundColor: GOLD + "08" },
  pickerItemName: { fontFamily: "Inter_700Bold", fontSize: 16, color: Colors.text, marginBottom: 2 },
  pickerItemDate: { fontFamily: "Inter_400Regular", fontSize: 12, color: Colors.textSecondary, marginBottom: 2 },
  pickerItemOrg: { fontFamily: "Inter_400Regular", fontSize: 12, color: Colors.muted },
  pickerItemFormat: { fontFamily: "Inter_400Regular", fontSize: 11, color: Colors.textSecondary },

  // ── New UX: More Views / Bottom Sheet modals ─────────────────────────
  moreModalBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end",
  },
  moreModalSheet: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 16, paddingBottom: 40,
    borderTopWidth: 1, borderColor: Colors.border,
  },
  moreModalTitle: {
    fontFamily: "Inter_700Bold", fontSize: 17, color: Colors.text,
    paddingVertical: 16, textAlign: "center",
  },
  moreModalItem: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Colors.border + "60",
  },
  moreModalItemActive: {},
  moreModalItemLabel: { fontFamily: "Inter_600SemiBold", fontSize: 16, color: Colors.text, flex: 1 },
  moreModalItemDesc: { fontFamily: "Inter_400Regular", fontSize: 12, color: Colors.muted, marginTop: 2, flex: 1 },

  // Task #620 — backdrop for the friendly consent prompt modal.
  consentBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center", alignItems: "stretch", paddingHorizontal: 8,
  },
});
