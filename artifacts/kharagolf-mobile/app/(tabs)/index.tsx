import { Feather, Ionicons } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useFocusEffect } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { fetchPublic, fetchPortal, postPortal, BASE_URL } from "@/utils/api";
import { getExpoNotifications } from "@/utils/expoNotifications";
import { useAuth } from "@/context/auth";
import { isMemberAdmin } from "@workspace/member-admin-roles";
import { useActiveClub } from "@/context/activeClub";
import { useTheme } from "@/theme";
import TournamentRegistrationSheet, { type TournamentForRegistration } from "@/components/TournamentRegistrationSheet";
import { MyUpcomingWidget } from "@/components/MyUpcomingWidget";
import { StalledExpiringReminderCard } from "@/components/StalledExpiringReminderCard";
import { getLocale } from "@/i18n";
import { formatRelativeTime } from "@/i18n/relativeTime";
import { useTranslation } from "react-i18next";

const GOLD = "#C9A84C";

// ── Type definitions ───────────────────────────────────────────────────────────

interface Tournament {
  id: number;
  name: string;
  format: string;
  status: string;
  startDate?: string | null;
  endDate?: string | null;
  organizationId: number;
  organizationName: string;
  courseName?: string | null;
  entryFee?: string | null;
  currency?: string;
  maxPlayers?: number | null;
  playerCount?: number;
  isFull?: boolean;
}

interface MyTournament {
  playerId: number;
  tournamentId: number;
  tournamentName: string;
  tournamentStatus: string;
  startDate: string | null;
  endDate: string | null;
  paymentStatus: string;
  checkedIn: boolean;
  tournamentFormat: string;
  handicapIndex: string | null;
}

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

interface FeedPost {
  id: number;
  type: string;
  body: string;
  isPinned: boolean;
  reactionsCount: number;
  commentsCount: number;
  createdAt: string;
  authorDisplayName: string | null;
  authorProfileImage: string | null;
  media: { url: string; mimeType: string }[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const FORMAT_LABELS: Record<string, string> = {
  stroke_play: "Stroke Play",
  stableford: "Stableford",
  match_play: "Match Play",
  scramble: "Scramble",
  best_ball: "Best Ball",
  skins: "Skins",
  net_stroke: "Net Stroke",
  shamble: "Shamble",
};

function fmtDate(d: string | null | undefined) {
  if (!d) return "Date TBD";
  return new Date(d).toLocaleDateString(getLocale(), { month: "short", day: "numeric", year: "numeric" });
}

function timeAgo(dateStr: string) {
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  // <24h: route through the shared `formatRelativeTime` helper so every
  // supported locale (including Arabic counts 2..10, the bug Task #1659
  // fixed) gets correctly-translated copy via Intl.RelativeTimeFormat
  // instead of the previous English-only "Xm ago"/"Xh ago" fragments.
  // For older posts we keep the absolute calendar date (e.g. "Apr 14") so
  // the feed stays scannable at a glance.
  if (diff < 86400) return formatRelativeTime(dateStr);
  return new Date(dateStr).toLocaleDateString(getLocale(), { day: "numeric", month: "short" });
}

// ── Quick action tiles ─────────────────────────────────────────────────────────

interface QuickAction {
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  onPress: () => void;
}

// ── Components ─────────────────────────────────────────────────────────────────

function HeroTournamentCard({ tournament, onRegister }: { tournament: Tournament; onRegister: (t: Tournament) => void }) {
  const { t } = useTranslation("home");
  const isLive = tournament.status === "active";
  const statusColor = isLive ? Colors.primary : GOLD;

  return (
    <Pressable
      style={styles.heroCard}
      onPress={() => router.push({ pathname: "/(tabs)/leaderboard", params: { tournamentId: String(tournament.id) } })}
    >
      <View style={styles.heroAccent} />
      <View style={styles.heroBody}>
        <View style={styles.heroTop}>
          <View style={[styles.liveBadge, { backgroundColor: statusColor + "20", borderColor: statusColor + "60" }]}>
            {isLive && <View style={[styles.liveDot, { backgroundColor: statusColor }]} />}
            <Text style={[styles.liveText, { color: statusColor }]}>
              {isLive ? t("live") : t("upcoming")}
            </Text>
          </View>
          <Text style={styles.heroFormat}>{FORMAT_LABELS[tournament.format] ?? tournament.format}</Text>
        </View>
        <Text style={styles.heroName} numberOfLines={2}>{tournament.name}</Text>
        <Text style={styles.heroOrg}>{tournament.organizationName}</Text>
        <View style={styles.heroMeta}>
          {tournament.courseName ? (
            <View style={styles.metaRow}>
              <Feather name="map-pin" size={12} color={Colors.textSecondary} accessibilityElementsHidden importantForAccessibility="no" />
              <Text style={styles.metaText} numberOfLines={1}>{tournament.courseName}</Text>
            </View>
          ) : null}
          <View style={styles.metaRow}>
            <Feather name="calendar" size={12} color={Colors.textSecondary} accessibilityElementsHidden importantForAccessibility="no" />
            <Text style={styles.metaText}>{fmtDate(tournament.startDate)}</Text>
          </View>
        </View>
        <View style={styles.heroFooter}>
          {tournament.status === "upcoming" ? (
            <TouchableOpacity
              style={styles.registerBtn}
              onPress={() => onRegister(tournament)}
              activeOpacity={0.78}
            >
              <Text style={styles.registerBtnText}>
                {tournament.isFull ? t("joinWaitlist") : t("registerNow")}
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.leaderboardBtn}
              onPress={() => router.push({ pathname: "/(tabs)/leaderboard", params: { tournamentId: String(tournament.id) } })}
              activeOpacity={0.78}
            >
              <Ionicons name="trophy" size={13} color={GOLD} accessibilityElementsHidden importantForAccessibility="no" />
              <Text style={styles.leaderboardBtnText}>{t("viewLeaderboard")}</Text>
            </TouchableOpacity>
          )}
          <Feather name="chevron-right" size={18} color={Colors.muted} accessibilityElementsHidden importantForAccessibility="no" />
        </View>
      </View>
    </Pressable>
  );
}

// Exported for __tests__/screen-reader-transcripts.test.tsx (Task #2173) so
// the tile's composite "label. sublabel" accessibilityLabel and the
// `accessible={false}` icon-wrap can be pinned without mounting the whole
// HomeScreen tree. The component is otherwise a private helper of HomeScreen.
export function QuickActionTile({ item }: { item: QuickAction }) {
  return (
    <TouchableOpacity
      style={styles.qaTile}
      onPress={item.onPress}
      activeOpacity={0.75}
      accessibilityRole="button"
      accessibilityLabel={`${item.label}. ${item.sublabel}`}
    >
      <View style={styles.qaIconWrap} accessible={false}>{item.icon}</View>
      <Text style={styles.qaLabel}>{item.label}</Text>
      <Text style={styles.qaSublabel} numberOfLines={1}>{item.sublabel}</Text>
    </TouchableOpacity>
  );
}

function MyEventCard({ item }: { item: MyTournament | MyLeague }) {
  const { t } = useTranslation("home");
  const isTournament = "tournamentId" in item;

  if (isTournament) {
    const row = item as MyTournament;
    const isActive = row.tournamentStatus === "active";
    const statusColor = isActive ? Colors.primary : GOLD;
    return (
      <Pressable
        style={styles.myEventCard}
        onPress={() => router.push({ pathname: "/(tabs)/leaderboard", params: { tournamentId: String(row.tournamentId) } })}
      >
        <View style={[styles.myEventDot, { backgroundColor: statusColor }]} />
        <View style={styles.myEventContent}>
          <Text style={styles.myEventName} numberOfLines={1}>{row.tournamentName}</Text>
          <Text style={styles.myEventMeta}>{FORMAT_LABELS[row.tournamentFormat] ?? row.tournamentFormat} · {fmtDate(row.startDate)}</Text>
        </View>
        <View style={[styles.myEventStatus, { backgroundColor: statusColor + "20" }]}>
          <Text style={[styles.myEventStatusText, { color: statusColor }]}>{row.tournamentStatus.toUpperCase()}</Text>
        </View>
      </Pressable>
    );
  }

  const l = item as MyLeague;
  return (
    <Pressable
      style={styles.myEventCard}
      onPress={() => router.push("/(tabs)/leaderboard")}
    >
      <View style={[styles.myEventDot, { backgroundColor: Colors.secondary }]} />
      <View style={styles.myEventContent}>
        <Text style={styles.myEventName} numberOfLines={1}>{l.leagueName}</Text>
        <Text style={styles.myEventMeta}>{t("leagueLabel", { format: l.leagueFormat })}</Text>
      </View>
      {l.position != null ? (
        <View style={[styles.myEventStatus, { backgroundColor: GOLD + "20" }]}>
          <Text style={[styles.myEventStatusText, { color: GOLD }]}>#{l.position}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function FeedCard({ post }: { post: FeedPost }) {
  const { t } = useTranslation("home");
  const hasMedia = post.media.length > 0 && post.media[0].mimeType.startsWith("image/");

  return (
    <View style={styles.feedCard}>
      <View style={styles.feedAuthorRow}>
        <View style={styles.feedAvatar}>
          <Text style={styles.feedAvatarText}>
            {(post.authorDisplayName ?? "?").charAt(0).toUpperCase()}
          </Text>
        </View>
        <View>
          <Text style={styles.feedAuthor}>{post.authorDisplayName ?? t("member")}</Text>
          <Text style={styles.feedTime}>{timeAgo(post.createdAt)}</Text>
        </View>
        {post.isPinned ? <Feather name="bookmark" size={13} color={GOLD} style={styles.feedPin} /> : null}
      </View>
      {hasMedia ? (
        <Image
          source={{ uri: `${BASE_URL}${post.media[0].url}` }}
          style={styles.feedImage}
          resizeMode="cover"
        />
      ) : null}
      <Text style={styles.feedBody} numberOfLines={3}>{post.body}</Text>
      <View style={styles.feedFooter}>
        <View style={styles.feedReact}>
          <Feather name="heart" size={13} color={Colors.muted} />
          <Text style={styles.feedReactCount}>{post.reactionsCount}</Text>
        </View>
        <View style={styles.feedReact}>
          <Feather name="message-circle" size={13} color={Colors.muted} />
          <Text style={styles.feedReactCount}>{post.commentsCount}</Text>
        </View>
      </View>
    </View>
  );
}

// ── Stuck-erasure backlog widget ─────────────────────────────────────────────

// Task #1771 — mirrors the web StuckErasureBacklogWidget. Self-hides
// for non-controllers (server 401/403) and when the backlog is empty.
interface ErasureStorageFailuresSummary {
  count: number;
  totalFailedFiles: number;
  // Task #2217 — sub-count of members whose auto-retry chain has been
  // exhausted (cron has given up; controller intervention required).
  // Mirrors the field surfaced by the web widget so the mobile home
  // dashboard stays in lockstep with the desktop "needs your action"
  // sub-pill rather than only showing the flat backlog count.
  autoRetryExhaustedCount: number;
  pendingStorageDeletions: { total: number; exhausted: number };
}

function StuckErasureBacklog({ orgId, token }: { orgId: number; token: string }) {
  const { t } = useTranslation("home");
  const queryKey = ["stuck-erasure-summary", orgId] as const;
  const { data, isLoading } = useQuery<ErasureStorageFailuresSummary | null>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(
        `${BASE_URL}/api/organizations/${orgId}/members-360/erasures/storage-failures/summary`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw new Error("Failed to load stuck erasure summary");
      return res.json();
    },
    enabled: !!orgId && !!token,
    refetchInterval: 60_000,
    retry: false,
  });

  if (!isLoading && data === null) return null;
  if (
    !isLoading &&
    data &&
    data.count === 0 &&
    data.pendingStorageDeletions.exhausted === 0
  ) {
    return null;
  }

  const count = data?.count ?? 0;
  const exhausted = data?.pendingStorageDeletions.exhausted ?? 0;
  // Task #2217 — members whose auto-retry chain is fully exhausted.
  // Surfaced as a separate destructive "needs your action" pill next
  // to the amber backlog count so a controller triaging from their
  // phone can tell at a glance whether the cron is still working
  // through the queue or has given up and is waiting on them. Mirrors
  // the same sub-pill the web dashboard renders.
  const needsActionCount = data?.autoRetryExhaustedCount ?? 0;

  // Task #2209 — push to the native stuck-erasure cleanup screen instead
  // of bouncing out to the web /privacy?panel=erasure-storage-failures
  // page via expo-web-browser. The native screen mirrors the panel and
  // adds pull-to-refresh, so org-admin controllers can triage entirely
  // in-app.
  const onPress = () => {
    // `as never` mirrors the typed-router escape hatch used elsewhere
    // for newly-added routes that the auto-generated `.expo/types/router.d.ts`
    // hasn't seen yet — Expo regenerates the type list on next dev start.
    router.push("/erasure-cleanup" as never);
  };

  const summary = t("stuckErasureSummary", { count });
  const exhaustedText = exhausted > 0
    ? t("stuckErasureExhausted", { count: exhausted })
    : null;

  return (
    <TouchableOpacity
      testID="home-stuck-erasure-card"
      accessibilityRole="button"
      accessibilityLabel={t("stuckErasureBadgeA11y", { count })}
      onPress={onPress}
      style={styles.stuckErasureCard}
      activeOpacity={0.78}
    >
      <View style={styles.stuckErasureIconWrap}>
        <Feather
          name="alert-triangle"
          size={18}
          color="#fcd34d"
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.stuckErasureTitleRow}>
          <Text style={styles.stuckErasureTitle} numberOfLines={1}>
            {t("stuckErasureTitle")}
          </Text>
          {!isLoading && (count > 0 || exhausted > 0) ? (
            <View
              style={styles.stuckErasureBadge}
              testID="home-stuck-erasure-badge"
            >
              <Text style={styles.stuckErasureBadgeText}>{count}</Text>
            </View>
          ) : null}
          {!isLoading && needsActionCount > 0 ? (
            // Task #2217 — destructive sub-pill mirrors the web
            // dashboard's "{n} needs action" badge so the home tab is
            // a true triage surface on mobile too. The whole card is
            // a single TouchableOpacity, so the badge inherits the
            // same tap-target the count badge uses — the native
            // `/erasure-cleanup` screen (Task #2209) where the
            // per-member "needs your action" rows live.
            <View
              style={styles.stuckErasureNeedsActionBadge}
              testID="home-stuck-erasure-needs-action-badge"
              accessibilityLabel={t("stuckErasureNeedsActionA11y", {
                count: needsActionCount,
              })}
            >
              <Text style={styles.stuckErasureNeedsActionBadgeText}>
                {t("stuckErasureNeedsAction", { count: needsActionCount })}
              </Text>
            </View>
          ) : null}
        </View>
        {isLoading ? (
          <LoadingSpinner
            size="small"
            color="#fcd34d"
            style={{ alignSelf: "flex-start", marginTop: 6 }}
          />
        ) : (
          <>
            <Text
              style={styles.stuckErasureSummary}
              testID="home-stuck-erasure-summary"
              numberOfLines={2}
            >
              {summary}
              {exhaustedText ? ` · ${exhaustedText}` : ""}
            </Text>
            <View style={styles.stuckErasureLinkRow}>
              <Text style={styles.stuckErasureLink}>
                {t("stuckErasureOpen")}
              </Text>
              <Feather
                name="external-link"
                size={13}
                color="#fcd34d"
                accessibilityElementsHidden
                importantForAccessibility="no"
              />
            </View>
          </>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ── Main screen ────────────────────────────────────────────────────────────────

// Task #1495 — one-time backfill announcement card pointing existing
// members at the new "Side-game payment receipts" toggle on the
// communications-prefs screen. Mirrors the web banner added in
// Task #1270 so mobile-only members can also discover the toggle.
interface SideGameReceiptToggleAnnouncement {
  id: number;
  subject: string;
  body: string;
  sentAt: string;
  prefsUrl: string;
  prefsAnchor: string;
}

const SIDE_GAME_RECEIPT_TOGGLE_QUERY_KEY = "side-game-receipt-toggle-announcement";

export default function HomeScreen() {
  const { t } = useTranslation("home");
  const insets = useSafeAreaInsets();
  const { token, user } = useAuth();
  const { activeClub } = useActiveClub();
  // Task #1757 — surface the saved club logo in the home header so
  // players see their club's mark on the most-visited screen. Mirrors
  // the player tab bar's `customized`-gated logic from Task #1438 so
  // the legacy `activeClub` fallback during initial load doesn't flash
  // a stale logo before the real /theming response settles.
  const { logoUrl, customized } = useTheme();
  const showClubLogo = customized && !!logoUrl;
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTournament, setSelectedTournament] = useState<TournamentForRegistration | null>(null);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [dismissingSideGameAnnouncement, setDismissingSideGameAnnouncement] = useState(false);

  // Public tournaments for hero card
  const { data: tournaments, refetch: refetchTournaments } = useQuery({
    queryKey: ["public-tournaments"],
    queryFn: () => fetchPublic<Tournament[]>("/tournaments"),
    staleTime: 60_000,
  });

  // My tournaments & leagues
  const { data: myTournaments, refetch: refetchMyTournaments } = useQuery({
    queryKey: ["my-tournaments", token],
    queryFn: () => fetchPortal<MyTournament[]>("/my-tournaments", token!),
    enabled: !!token,
    staleTime: 30_000,
  });

  const { data: myLeagues, refetch: refetchMyLeagues } = useQuery({
    queryKey: ["my-leagues", token],
    queryFn: () => fetchPortal<MyLeague[]>("/my-leagues", token!),
    enabled: !!token,
    staleTime: 30_000,
  });

  // Club social feed
  const orgId = activeClub?.id ?? user?.organizationId;
  const { data: feedPosts, refetch: refetchFeed } = useQuery({
    queryKey: ["club-feed-home", orgId, token],
    queryFn: async () => {
      if (!orgId || !token) return [] as FeedPost[];
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/social/feed`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return [] as FeedPost[];
      const data = await res.json() as { posts?: FeedPost[] };
      return (data.posts ?? []).slice(0, 5);
    },
    enabled: !!token && !!orgId,
    staleTime: 60_000,
  });

  // Player stats including handicap trend
  interface HomeStats { tournamentsPlayed: number; totalScores: number; averageStrokes: number | null; bestRound: number | null; hcpTrend?: { handicapIndex: number; recordedAt: string | null }[] }
  const { data: wellnessToday } = useQuery({
    queryKey: ["wellnessToday", token],
    queryFn: () => fetchPortal<{
      today: { metricDate: string; readinessScore: number | null; sleepMinutes: number | null; sources: string[] } | null;
      recommendation: { level: "full" | "conservative" | "rest"; label: string; detail: string; score: number | null };
    }>("/wellness/today", token!),
    enabled: !!token,
  });

  const { data: homeStats, refetch: refetchStats } = useQuery({
    queryKey: ["home-my-stats", token],
    queryFn: () => fetchPortal<HomeStats>("/my-stats", token!),
    enabled: !!token,
    staleTime: 120_000,
  });

  // Committee inbox — unread peer-response count for committee members.
  // Uses a lightweight count endpoint so the home screen never has to
  // download the full notifications list (which can grow large) just to
  // render a badge. The full list is only fetched when the user opens the
  // notifications inbox screen.
  interface PeerResponseSummary { unreadCount: number; hasAny: boolean }
  const { data: committeeNotifs, refetch: refetchCommitteeNotifs } = useQuery({
    queryKey: ["home-committee-notifications-count", token],
    queryFn: () => fetchPortal<PeerResponseSummary>(
      "/handicap/notifications/unread-count?event=peer_responded",
      token!,
    ),
    enabled: !!token,
    staleTime: 30_000,
  });
  const unreadPeerResponses = committeeNotifs?.unreadCount ?? 0;
  const showCommitteeInbox = committeeNotifs?.hasAny ?? false;

  // Task #1495 — fetch the side-game-receipt-toggle backfill announcement.
  // Server returns `{ announcement: null }` for newly-registered members,
  // members who already dismissed it, or members without a club_members row,
  // so we never have to filter client-side. We let React Query handle retries
  // on transient network failures (so a flaky first request doesn't suppress
  // the banner for the rest of the session) and keep `staleTime: Infinity`
  // plus a manual `setQueryData(null)` on dismiss to prevent the banner from
  // briefly reappearing if the user navigates away and back before the POST
  // round-trip completes. On hard failure the data stays undefined and the
  // banner simply isn't rendered — it will retry naturally on the next
  // refetch trigger (refresh, reopen, etc).
  const { data: sideGameAnnouncementData } = useQuery({
    queryKey: [SIDE_GAME_RECEIPT_TOGGLE_QUERY_KEY, token],
    queryFn: () => fetchPortal<{ announcement: SideGameReceiptToggleAnnouncement | null }>(
      "/announcements/side-game-receipt-toggle",
      token!,
    ),
    enabled: !!token,
    staleTime: Infinity,
    retry: 2,
  });
  const sideGameAnnouncement = sideGameAnnouncementData?.announcement ?? null;

  // Refresh the committee badge whenever the home screen regains focus so the
  // count stays in sync with what the user just read in the inbox.
  useFocusEffect(
    useCallback(() => {
      if (token) void refetchCommitteeNotifs();
    }, [token, refetchCommitteeNotifs]),
  );

  // Real-time path: invalidate the committee-inbox count query the moment a
  // `peer_responded` push arrives, so a member who is already on the home
  // screen sees the new badge without having to navigate away and back. The
  // `useFocusEffect` above only fires on focus events, which leaves the
  // badge stale for foreground pushes. Fires for foreground notifications
  // and (on iOS) for notifications delivered while the app is open.
  useEffect(() => {
    if (!token) return;
    const Notifications = getExpoNotifications();
    const sub = Notifications?.addNotificationReceivedListener((notification) => {
      const data = notification?.request?.content?.data as
        | Record<string, unknown>
        | undefined;
      const type = typeof data?.type === "string" ? (data.type as string) : "";
      if (type === "peer_responded") {
        void queryClient.invalidateQueries({
          queryKey: ["home-committee-notifications-count", token],
        });
      }
    });
    return () => {
      sub?.remove();
    };
  }, [token, queryClient]);

  // Task #1495 — dismiss the side-game-receipt-toggle backfill announcement.
  // Optimistically clears the card, navigates to the comm-prefs screen when
  // the user tapped "Open settings" (passing `focus=sideGameReceipts` so the
  // screen scrolls to the matching row), then POSTs the dismissal. On
  // failure we restore the previous announcement so the member can retry.
  const dismissSideGameAnnouncement = useCallback(async (openPrefs: boolean) => {
    if (!sideGameAnnouncement || dismissingSideGameAnnouncement || !token) return;
    const prev = sideGameAnnouncement;
    setDismissingSideGameAnnouncement(true);
    queryClient.setQueryData<{ announcement: SideGameReceiptToggleAnnouncement | null }>(
      [SIDE_GAME_RECEIPT_TOGGLE_QUERY_KEY, token],
      { announcement: null },
    );
    if (openPrefs) {
      router.push({ pathname: "/my-360/communications", params: { focus: "sideGameReceipts" } });
    }
    try {
      await postPortal("/announcements/side-game-receipt-toggle/dismiss", token, {});
    } catch {
      queryClient.setQueryData<{ announcement: SideGameReceiptToggleAnnouncement | null }>(
        [SIDE_GAME_RECEIPT_TOGGLE_QUERY_KEY, token],
        { announcement: prev },
      );
    } finally {
      setDismissingSideGameAnnouncement(false);
    }
  }, [sideGameAnnouncement, dismissingSideGameAnnouncement, token, queryClient]);

  const homeHcp = homeStats?.hcpTrend?.length
    ? Number(homeStats.hcpTrend[homeStats.hcpTrend.length - 1].handicapIndex)
    : null;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refetchTournaments(), refetchMyTournaments(), refetchMyLeagues(), refetchFeed(), refetchStats(), refetchCommitteeNotifs()]);
    setRefreshing(false);
  }, [refetchTournaments, refetchMyTournaments, refetchMyLeagues, refetchFeed, refetchStats, refetchCommitteeNotifs]);

  // Pick hero tournament: live first, then next upcoming
  const heroTournament = (() => {
    if (!tournaments?.length) return null;
    const live = tournaments.find((t) => t.status === "active");
    if (live) return live;
    const upcoming = tournaments
      .filter((t) => t.status === "upcoming" && t.startDate)
      .sort((a, b) => new Date(a.startDate!).getTime() - new Date(b.startDate!).getTime());
    return upcoming[0] ?? null;
  })();

  function openRegistration(t: Tournament) {
    setSelectedTournament({
      id: t.id,
      name: t.name,
      format: t.format,
      status: t.status,
      startDate: t.startDate ?? undefined,
      endDate: t.endDate ?? undefined,
      organizationId: t.organizationId,
      organizationName: t.organizationName,
      courseName: t.courseName ?? undefined,
      entryFee: t.entryFee ?? null,
      currency: t.currency ?? "INR",
      maxPlayers: t.maxPlayers ?? null,
      playerCount: t.playerCount ?? 0,
      isFull: t.isFull ?? false,
    });
    setSheetVisible(true);
  }

  const QUICK_ACTIONS: QuickAction[] = [
    {
      icon: <Feather name="clock" size={22} color={GOLD} />,
      label: t("teeBookings"),
      sublabel: t("teeBookingsSub"),
      onPress: () => router.push("/tee-bookings"),
    },
    {
      icon: <Feather name="edit-2" size={22} color={Colors.primary} />,
      label: t("score"),
      sublabel: t("scoreSub"),
      onPress: () => router.push("/(tabs)/score"),
    },
    {
      icon: <Ionicons name="trophy" size={22} color={Colors.secondary} />,
      label: t("compete"),
      sublabel: t("competeSub"),
      onPress: () => router.push("/(tabs)/leaderboard"),
    },
    {
      icon: <Feather name="message-square" size={22} color={Colors.textSecondary} />,
      label: t("clubFeed"),
      sublabel: t("clubFeedSub"),
      onPress: () => router.push("/(tabs)/feed"),
    },
  ];

  // Combined my events list
  const myEvents: (MyTournament | MyLeague)[] = [
    ...(myTournaments ?? []).slice(0, 3),
    ...(myLeagues ?? []).slice(0, 2),
  ];

  const greeting = () => {
    const h = new Date().getHours();
    if (h < 12) return t("greetMorning");
    if (h < 17) return t("greetAfternoon");
    return t("greetEvening");
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          {showClubLogo ? (
            <Image
              source={{ uri: logoUrl! }}
              style={styles.headerLogo}
              resizeMode="contain"
              accessibilityLabel={activeClub?.name ?? "Club logo"}
            />
          ) : null}
          <View style={styles.headerLeftText}>
            <Text style={styles.greeting}>{greeting()}</Text>
            <Text style={styles.username} numberOfLines={1}>
              {user?.displayName ?? user?.username ?? t("golfer")}
            </Text>
          </View>
        </View>
        <TouchableOpacity
          style={styles.notifBtn}
          onPress={() => router.push("/(tabs)/updates")}
          accessibilityRole="button"
          accessibilityLabel="Notifications"
        >
          <Feather name="bell" size={20} color={Colors.textSecondary} accessible={false} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 90 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={GOLD} />
        }
      >
        {/* Task #1495 — one-time backfill announcement card pointing
            existing members at the new "Side-game payment receipts"
            toggle. Auto-dismisses on either button (server-side readAt
            stamp) so it never reappears, even on a different device. */}
        {token && sideGameAnnouncement ? (
          <View style={styles.section}>
            <View
              style={styles.sgAnnouncementCard}
              testID="card-side-game-receipt-toggle-announcement"
            >
              <View style={styles.sgAnnouncementIconWrap}>
                <Feather
                  name="bell"
                  size={18}
                  color={Colors.primary}
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.sgAnnouncementTitle}>{sideGameAnnouncement.subject}</Text>
                <Text style={styles.sgAnnouncementBody}>{sideGameAnnouncement.body}</Text>
                <View style={styles.sgAnnouncementButtons}>
                  <TouchableOpacity
                    disabled={dismissingSideGameAnnouncement}
                    onPress={() => dismissSideGameAnnouncement(true)}
                    style={[
                      styles.sgPrimaryBtn,
                      dismissingSideGameAnnouncement && styles.sgBtnDisabled,
                    ]}
                    testID="btn-side-game-receipt-toggle-open-prefs"
                    accessibilityRole="button"
                    accessibilityLabel="Open settings"
                  >
                    <Text style={styles.sgPrimaryBtnText}>Open settings</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    disabled={dismissingSideGameAnnouncement}
                    onPress={() => dismissSideGameAnnouncement(false)}
                    style={[
                      styles.sgSecondaryBtn,
                      dismissingSideGameAnnouncement && styles.sgBtnDisabled,
                    ]}
                    testID="btn-side-game-receipt-toggle-got-it"
                    accessibilityRole="button"
                    accessibilityLabel="Got it"
                  >
                    <Text style={styles.sgSecondaryBtnText}>Got it</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </View>
        ) : null}

        {/* Hero tournament card */}
        {heroTournament ? (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>{t("featuredEvent")}</Text>
            <HeroTournamentCard tournament={heroTournament} onRegister={openRegistration} />
          </View>
        ) : null}

        {token && (
          <View style={styles.section}>
            <MyUpcomingWidget />
          </View>
        )}

        {/* Your Activity strip */}
        {token && homeStats && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>{t("yourActivity")}</Text>
            {/* Active / next event banner */}
            {(() => {
              const active = myTournaments?.find((t) => t.tournamentStatus === "active");
              const next = !active ? myTournaments?.find((t) => t.tournamentStatus === "upcoming") : undefined;
              const evt = active ?? next;
              if (!evt) return null;
              return (
                <TouchableOpacity
                  onPress={() => router.push({ pathname: "/(tabs)/leaderboard", params: { tournamentId: String(evt.tournamentId) } })}
                  style={{ backgroundColor: active ? Colors.primary + '18' : '#1a2c22', borderRadius: 14, borderWidth: 1, borderColor: active ? Colors.primary + '50' : '#243b2e', padding: 14, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 12 }}
                >
                  {active && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: Colors.primary }} />}
                  {!active && <Ionicons name="calendar-outline" size={18} color={GOLD} accessibilityElementsHidden importantForAccessibility="no" />}
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, color: active ? Colors.primary : '#e8f5ee', fontFamily: 'Inter_600SemiBold' }} numberOfLines={1}>
                      {active ? t("liveEvent") : t("nextEvent")}{evt.tournamentName}
                    </Text>
                    {evt.startDate && (
                      <Text style={{ fontSize: 12, color: '#4b7060', fontFamily: 'Inter_400Regular', marginTop: 2 }}>
                        {new Date(evt.startDate).toLocaleDateString(getLocale(), { month: 'short', day: 'numeric', year: 'numeric' })}
                      </Text>
                    )}
                  </View>
                  <Feather name="chevron-right" size={16} color={active ? Colors.primary : '#4b7060'} accessibilityElementsHidden importantForAccessibility="no" />
                </TouchableOpacity>
              );
            })()}
            {/* Pre-round readiness card (Whoop / Garmin / Apple Health / Google Fit) */}
            {wellnessToday?.recommendation && (() => {
              const rec = wellnessToday.recommendation;
              const colorByLevel = { full: '#3ecf8e', conservative: GOLD, rest: '#ff6b6b' } as const;
              const accent = colorByLevel[rec.level] ?? GOLD;
              return (
                <TouchableOpacity
                  onPress={() => router.push('/(tabs)/profile')}
                  style={{ backgroundColor: '#1a2c22', borderRadius: 14, borderWidth: 1, borderColor: accent + '60', padding: 14, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 12 }}
                >
                  <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: accent + '22', alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 22, color: accent, fontFamily: 'Inter_700Bold' }}>{rec.score != null ? rec.score : '—'}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 11, color: '#4b7060', fontFamily: 'Inter_600SemiBold', letterSpacing: 1.2, textTransform: 'uppercase' }}>Readiness</Text>
                    <Text style={{ fontSize: 14, color: '#e8f5ee', fontFamily: 'Inter_600SemiBold', marginTop: 2 }} numberOfLines={1}>{rec.label}</Text>
                    <Text style={{ fontSize: 12, color: '#8aa599', fontFamily: 'Inter_400Regular', marginTop: 3 }} numberOfLines={2}>{rec.detail}</Text>
                  </View>
                </TouchableOpacity>
              );
            })()}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              {/* Handicap index */}
              <TouchableOpacity
                onPress={() => router.push('/handicap-profile')}
                style={{ flex: 1, backgroundColor: '#1a2c22', borderRadius: 14, borderWidth: 1, borderColor: '#243b2e', padding: 14, alignItems: 'center' }}
              >
                <Text style={{ fontSize: 11, color: '#4b7060', fontFamily: 'Inter_600SemiBold', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 6 }}>{t("handicap")}</Text>
                <Text style={{ fontSize: 32, color: GOLD, fontFamily: 'Inter_700Bold', lineHeight: 36 }}>
                  {homeHcp != null ? homeHcp.toFixed(1) : '—'}
                </Text>
                <Text style={{ fontSize: 11, color: '#4b7060', fontFamily: 'Inter_400Regular', marginTop: 4 }}>{t("whsIndex")}</Text>
              </TouchableOpacity>
              {/* Rounds played */}
              <TouchableOpacity
                onPress={() => router.push('/(tabs)/score')}
                style={{ flex: 1, backgroundColor: '#1a2c22', borderRadius: 14, borderWidth: 1, borderColor: '#243b2e', padding: 14, alignItems: 'center' }}
              >
                <Text style={{ fontSize: 11, color: '#4b7060', fontFamily: 'Inter_600SemiBold', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 6 }}>{t("bestRound")}</Text>
                <Text style={{ fontSize: 32, color: '#e8f5ee', fontFamily: 'Inter_700Bold', lineHeight: 36 }}>
                  {homeStats.bestRound ?? '—'}
                </Text>
                <Text style={{ fontSize: 11, color: '#4b7060', fontFamily: 'Inter_400Regular', marginTop: 4 }}>{t("grossStrokes")}</Text>
              </TouchableOpacity>
              {/* Avg strokes */}
              <TouchableOpacity
                onPress={() => router.push('/(tabs)/score')}
                style={{ flex: 1, backgroundColor: '#1a2c22', borderRadius: 14, borderWidth: 1, borderColor: '#243b2e', padding: 14, alignItems: 'center' }}
              >
                <Text style={{ fontSize: 11, color: '#4b7060', fontFamily: 'Inter_600SemiBold', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 6 }}>{t("avgPerHole")}</Text>
                <Text style={{ fontSize: 32, color: '#e8f5ee', fontFamily: 'Inter_700Bold', lineHeight: 36 }}>
                  {homeStats.averageStrokes != null ? Number(homeStats.averageStrokes).toFixed(1) : '—'}
                </Text>
                <Text style={{ fontSize: 11, color: '#4b7060', fontFamily: 'Inter_400Regular', marginTop: 4 }}>{t("strokes")}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Stuck-erasure backlog — Task #2210. Client gate uses the shared
            `isMemberAdmin` helper so treasurers and membership secretaries
            (whose elevated role lives in `org_memberships`, not on
            `app_users.role`) actually see the badge instead of having the
            widget self-hide on a 401/403. The widget continues to self-hide
            when the backlog is empty, and the server still enforces access. */}
        {orgId && token && isMemberAdmin(user, orgId) ? (
          <StuckErasureBacklog orgId={orgId} token={token} />
        ) : null}

        {/* Task #1882 — mobile mirror of the web `StalledExpiringReminderWidget`
            (Task #1297). Lets controllers on their phone see members who
            opened the export-expiring reminder but haven't downloaded yet
            and fire a personal nudge before the daily purger removes the
            file. Self-hides on 401/403 (non-controllers); server enforces
            actual access. */}
        {orgId && token ? (
          <StalledExpiringReminderCard orgId={orgId} token={token} />
        ) : null}

        {/* Committee inbox entry — only for committee members */}
        {showCommitteeInbox && (
          <View style={styles.section}>
            <TouchableOpacity
              testID="home-committee-inbox-entry"
              accessibilityLabel={
                unreadPeerResponses > 0
                  ? `${t("committeeInbox")}, ${t("committeeInboxUnread", { count: unreadPeerResponses })}`
                  : t("committeeInbox")
              }
              onPress={() => router.push("/(tabs)/notifications")}
              style={styles.committeeCard}
              activeOpacity={0.78}
            >
              <View style={styles.committeeIconWrap}>
                <Feather name="shield" size={20} color={GOLD} accessibilityElementsHidden importantForAccessibility="no" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.committeeTitle}>{t("committeeInbox")}</Text>
                <Text style={styles.committeeSub} numberOfLines={1}>
                  {t("committeeInboxSub")}
                </Text>
              </View>
              {unreadPeerResponses > 0 && (
                <View style={styles.committeeBadge} testID="home-committee-inbox-badge">
                  <Text style={styles.committeeBadgeText}>{unreadPeerResponses}</Text>
                </View>
              )}
              <Feather name="chevron-right" size={18} color={Colors.muted} accessibilityElementsHidden importantForAccessibility="no" />
            </TouchableOpacity>
          </View>
        )}

        {/* Quick actions */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>{t("quickActions")}</Text>
          <View style={styles.qaGrid}>
            {QUICK_ACTIONS.map((a) => (
              <QuickActionTile key={a.label} item={a} />
            ))}
          </View>
        </View>

        {/* My events */}
        {myEvents.length > 0 ? (
          <View style={styles.section}>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionLabel}>{t("myEvents")}</Text>
              <TouchableOpacity onPress={() => router.push("/(tabs)/leaderboard")}>
                <Text style={styles.seeAll}>See all</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.myEventsStack}>
              {myEvents.map((e, i) => (
                <MyEventCard key={i} item={e} />
              ))}
            </View>
          </View>
        ) : token ? null : (
          <View style={styles.section}>
            <View style={styles.loginPrompt}>
              <Feather name="user" size={24} color={Colors.muted} />
              <Text style={styles.loginPromptText}>Sign in to see your tournaments and leagues</Text>
              <TouchableOpacity style={styles.loginBtn} onPress={() => router.push("/(auth)/login")}>
                <Text style={styles.loginBtnText}>Sign in</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* All tournaments */}
        {tournaments && tournaments.length > 0 ? (
          <View style={styles.section}>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionLabel}>ALL TOURNAMENTS</Text>
              <TouchableOpacity onPress={() => router.push("/(tabs)/leaderboard")}>
                <Text style={styles.seeAll}>See all</Text>
              </TouchableOpacity>
            </View>
            {tournaments.slice(0, 4).map((t) => (
              <TournamentRow
                key={t.id}
                t={t}
                myIds={myTournaments?.map((m) => m.tournamentId) ?? []}
                onRegister={openRegistration}
              />
            ))}
          </View>
        ) : null}

        {/* Club news feed */}
        {feedPosts && feedPosts.length > 0 ? (
          <View style={styles.section}>
            <View style={styles.sectionRow}>
              <Text style={styles.sectionLabel}>{t("clubFeedSection")}</Text>
              <TouchableOpacity onPress={() => router.push("/(tabs)/feed")}>
                <Text style={styles.seeAll}>See all</Text>
              </TouchableOpacity>
            </View>
            {feedPosts.slice(0, 3).map((p) => (
              <FeedCard key={p.id} post={p} />
            ))}
          </View>
        ) : null}
      </ScrollView>

      {/* Registration sheet */}
      {selectedTournament ? (
        <TournamentRegistrationSheet
          visible={sheetVisible}
          tournament={selectedTournament}
          token={token ?? null}
          onClose={() => {
            setSheetVisible(false);
            setSelectedTournament(null);
          }}
          onSuccess={() => {
            setSheetVisible(false);
            setSelectedTournament(null);
            void refetchMyTournaments();
          }}
        />
      ) : null}
    </View>
  );
}

// ── Small tournament row for "all tournaments" section ────────────────────────

function TournamentRow({
  t,
  myIds,
  onRegister,
}: {
  t: Tournament;
  myIds: number[];
  onRegister: (t: Tournament) => void;
}) {
  const isLive = t.status === "active";
  const isRegistered = myIds.includes(t.id);
  const color = isLive ? Colors.primary : t.status === "upcoming" ? GOLD : Colors.muted;

  return (
    <Pressable
      style={styles.tRow}
      onPress={() => router.push({ pathname: "/(tabs)/leaderboard", params: { tournamentId: String(t.id) } })}
    >
      <View style={[styles.tRowDot, { backgroundColor: color }]} />
      <View style={styles.tRowMid}>
        <Text style={styles.tRowName} numberOfLines={1}>{t.name}</Text>
        <Text style={styles.tRowSub}>{FORMAT_LABELS[t.format] ?? t.format} · {fmtDate(t.startDate)}</Text>
      </View>
      {!isRegistered && t.status === "upcoming" ? (
        <TouchableOpacity
          style={styles.tRowBtn}
          onPress={() => onRegister(t)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.tRowBtnText}>Enter</Text>
        </TouchableOpacity>
      ) : isRegistered ? (
        <Ionicons name="checkmark-circle" size={18} color={Colors.primary} accessibilityLabel="Registered" />
      ) : (
        <Feather name="chevron-right" size={16} color={Colors.muted} accessibilityElementsHidden importantForAccessibility="no" />
      )}
    </Pressable>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.background },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  headerLeftText: {
    flex: 1,
  },
  headerLogo: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: Colors.surface,
  },
  greeting: { fontSize: 12, color: Colors.muted, fontFamily: "Inter_400Regular" },
  username: { fontSize: 20, color: Colors.text, fontFamily: "Inter_700Bold", marginTop: 1 },
  notifBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: Colors.surface,
    borderWidth: 1, borderColor: Colors.border,
    alignItems: "center", justifyContent: "center",
  },

  // Scroll
  scroll: { padding: 16, gap: 0 },
  section: { marginBottom: 24 },
  sectionLabel: {
    fontSize: 11, color: Colors.textSecondary,
    letterSpacing: 1.8, fontFamily: "Inter_600SemiBold",
    marginBottom: 12,
  },
  sectionRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  seeAll: { fontSize: 13, color: GOLD, fontFamily: "Inter_500Medium" },

  // Hero card
  heroCard: {
    backgroundColor: Colors.card,
    borderRadius: 16, borderWidth: 1, borderColor: Colors.border,
    overflow: "hidden",
  },
  heroAccent: { height: 3, backgroundColor: GOLD },
  heroBody: { padding: 16 },
  heroTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  liveBadge: {
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 20, borderWidth: 1,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  liveText: { fontSize: 10, fontFamily: "Inter_700Bold", letterSpacing: 1 },
  heroFormat: { fontSize: 11, color: Colors.muted, fontFamily: "Inter_500Medium" },
  heroName: { fontSize: 20, color: Colors.text, fontFamily: "Inter_700Bold", marginBottom: 4 },
  heroOrg: { fontSize: 13, color: Colors.textSecondary, fontFamily: "Inter_400Regular", marginBottom: 12 },
  heroMeta: { gap: 5, marginBottom: 14 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  metaText: { fontSize: 12, color: Colors.textSecondary, fontFamily: "Inter_400Regular" },
  heroFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  registerBtn: {
    backgroundColor: GOLD, paddingHorizontal: 18, paddingVertical: 9,
    borderRadius: 10,
  },
  registerBtnText: { color: "#000", fontFamily: "Inter_700Bold", fontSize: 13 },
  leaderboardBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: GOLD + "15", paddingHorizontal: 14, paddingVertical: 9,
    borderRadius: 10, borderWidth: 1, borderColor: GOLD + "40",
  },
  leaderboardBtnText: { color: GOLD, fontFamily: "Inter_600SemiBold", fontSize: 13 },

  // Committee inbox
  committeeCard: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: Colors.card, borderRadius: 14, borderWidth: 1, borderColor: GOLD + "55",
    padding: 14,
  },
  committeeIconWrap: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: GOLD + "20", alignItems: "center", justifyContent: "center",
  },
  committeeTitle: { fontSize: 14, color: Colors.text, fontFamily: "Inter_600SemiBold" },
  committeeSub: { fontSize: 12, color: Colors.muted, fontFamily: "Inter_400Regular", marginTop: 2 },
  committeeBadge: {
    minWidth: 24, height: 24, borderRadius: 12, paddingHorizontal: 8,
    backgroundColor: "#ef4444", alignItems: "center", justifyContent: "center",
  },
  committeeBadgeText: { color: "#fff", fontSize: 12, fontFamily: "Inter_700Bold" },

  // Stuck-erasure backlog card (Task #1771) — amber alert mirrors the web widget.
  // marginBottom matches `section` so spacing is consistent when the
  // card renders, but collapses to zero when the widget self-hides
  // (no empty spacer wrapper).
  stuckErasureCard: {
    flexDirection: "row", alignItems: "flex-start", gap: 12,
    backgroundColor: Colors.card, borderRadius: 14, borderWidth: 1,
    borderColor: "#fbbf2466",
    padding: 14,
    marginBottom: 24,
  },
  stuckErasureIconWrap: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: "#fbbf2422",
    borderWidth: 1, borderColor: "#fbbf2455",
    alignItems: "center", justifyContent: "center",
  },
  stuckErasureTitleRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
  },
  stuckErasureTitle: {
    flex: 1,
    fontSize: 14, color: Colors.text, fontFamily: "Inter_600SemiBold",
  },
  stuckErasureBadge: {
    minWidth: 28, height: 22, borderRadius: 11, paddingHorizontal: 8,
    backgroundColor: "#fbbf2426",
    borderWidth: 1, borderColor: "#fbbf2466",
    alignItems: "center", justifyContent: "center",
  },
  stuckErasureBadgeText: {
    color: "#fcd34d", fontSize: 12, fontFamily: "Inter_700Bold",
  },
  // Task #2217 — destructive "needs your action" sub-pill that mirrors
  // the web dashboard's red-tinted variant. Sits next to the amber
  // backlog count so a controller can tell at a glance whether part
  // of the backlog has had its auto-retry chain exhausted.
  stuckErasureNeedsActionBadge: {
    height: 22, borderRadius: 11, paddingHorizontal: 8,
    backgroundColor: "#ef444426",
    borderWidth: 1, borderColor: "#ef444466",
    alignItems: "center", justifyContent: "center",
  },
  stuckErasureNeedsActionBadgeText: {
    color: "#fca5a5", fontSize: 12, fontFamily: "Inter_700Bold",
  },
  stuckErasureSummary: {
    fontSize: 12, color: Colors.textSecondary, fontFamily: "Inter_400Regular",
    marginTop: 6, lineHeight: 17,
  },
  stuckErasureLinkRow: {
    flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10,
  },
  stuckErasureLink: {
    color: "#fcd34d", fontSize: 13, fontFamily: "Inter_600SemiBold",
  },

  // Side-game receipt toggle announcement (Task #1495)
  sgAnnouncementCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: Colors.primary + "10",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.primary + "55",
    padding: 14,
  },
  sgAnnouncementIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: Colors.primary + "20",
    borderWidth: 1,
    borderColor: Colors.primary + "55",
    alignItems: "center",
    justifyContent: "center",
  },
  sgAnnouncementTitle: { fontSize: 14, color: Colors.text, fontFamily: "Inter_600SemiBold" },
  sgAnnouncementBody: {
    fontSize: 12,
    color: Colors.textSecondary,
    fontFamily: "Inter_400Regular",
    marginTop: 4,
    lineHeight: 17,
  },
  sgAnnouncementButtons: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  sgPrimaryBtn: {
    backgroundColor: Colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  sgPrimaryBtnText: { color: "#000", fontFamily: "Inter_700Bold", fontSize: 12 },
  sgSecondaryBtn: {
    backgroundColor: "transparent",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  sgSecondaryBtnText: { color: Colors.textSecondary, fontFamily: "Inter_600SemiBold", fontSize: 12 },
  sgBtnDisabled: { opacity: 0.5 },

  // Quick actions
  qaGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  qaTile: {
    width: "47.5%",
    backgroundColor: Colors.card, borderRadius: 14, borderWidth: 1, borderColor: Colors.border,
    padding: 14, gap: 6,
  },
  qaIconWrap: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: Colors.surface, alignItems: "center", justifyContent: "center",
    marginBottom: 2,
  },
  qaLabel: { fontSize: 14, color: Colors.text, fontFamily: "Inter_600SemiBold" },
  qaSublabel: { fontSize: 11, color: Colors.muted, fontFamily: "Inter_400Regular" },

  // My events
  myEventsStack: { gap: 8 },
  myEventCard: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: Colors.card, borderRadius: 12, borderWidth: 1, borderColor: Colors.border,
    padding: 14,
  },
  myEventDot: { width: 8, height: 8, borderRadius: 4 },
  myEventContent: { flex: 1 },
  myEventName: { fontSize: 14, color: Colors.text, fontFamily: "Inter_600SemiBold" },
  myEventMeta: { fontSize: 12, color: Colors.muted, fontFamily: "Inter_400Regular", marginTop: 2 },
  myEventStatus: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  myEventStatusText: { fontSize: 10, fontFamily: "Inter_700Bold" },

  // Login prompt
  loginPrompt: {
    backgroundColor: Colors.card, borderRadius: 14, borderWidth: 1, borderColor: Colors.border,
    padding: 20, alignItems: "center", gap: 10,
  },
  loginPromptText: { fontSize: 14, color: Colors.textSecondary, textAlign: "center", fontFamily: "Inter_400Regular" },
  loginBtn: {
    backgroundColor: GOLD, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 10,
  },
  loginBtnText: { color: "#000", fontFamily: "Inter_700Bold", fontSize: 14 },

  // Tournament rows
  tRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    backgroundColor: Colors.card, borderRadius: 12, borderWidth: 1, borderColor: Colors.border,
    padding: 14, marginBottom: 8,
  },
  tRowDot: { width: 8, height: 8, borderRadius: 4 },
  tRowMid: { flex: 1 },
  tRowName: { fontSize: 14, color: Colors.text, fontFamily: "Inter_600SemiBold" },
  tRowSub: { fontSize: 12, color: Colors.muted, fontFamily: "Inter_400Regular", marginTop: 2 },
  tRowBtn: {
    backgroundColor: GOLD + "20", paddingHorizontal: 12, paddingVertical: 5,
    borderRadius: 8, borderWidth: 1, borderColor: GOLD + "50",
  },
  tRowBtnText: { color: GOLD, fontSize: 12, fontFamily: "Inter_600SemiBold" },

  // Feed
  feedCard: {
    backgroundColor: Colors.card, borderRadius: 12, borderWidth: 1, borderColor: Colors.border,
    padding: 14, marginBottom: 10, gap: 10,
  },
  feedAuthorRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  feedAvatar: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: Colors.surface, alignItems: "center", justifyContent: "center",
  },
  feedAvatarText: { color: GOLD, fontSize: 15, fontFamily: "Inter_700Bold" },
  feedAuthor: { fontSize: 14, color: Colors.text, fontFamily: "Inter_600SemiBold" },
  feedTime: { fontSize: 12, color: Colors.muted, fontFamily: "Inter_400Regular" },
  feedPin: { marginLeft: "auto" },
  feedImage: { width: "100%", height: 180, borderRadius: 10 },
  feedBody: { fontSize: 14, color: Colors.textSecondary, fontFamily: "Inter_400Regular", lineHeight: 20 },
  feedFooter: { flexDirection: "row", gap: 16 },
  feedReact: { flexDirection: "row", alignItems: "center", gap: 5 },
  feedReactCount: { fontSize: 12, color: Colors.muted, fontFamily: "Inter_400Regular" },
});
