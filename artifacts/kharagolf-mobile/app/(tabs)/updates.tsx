import React, { useCallback, useEffect, useState } from "react";
import {
  FlatList,
  Image,
  Linking,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import * as Notifications from "expo-notifications";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/context/auth";
import { useUnread } from "@/context/unread";
import { useMoreBadges } from "@/context/moreBadges";
import { formatRelativeTime } from "@/i18n/relativeTime";
import { getLocale } from "@/i18n/locale";
import Colors from "@/constants/colors";

const BASE_URL = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : "";

const POLL_INTERVAL_MS = 30_000;

type FeatherIconName = React.ComponentProps<typeof Feather>["name"];

interface MyTournament {
  tournamentId: number;
  tournamentName: string;
  tournamentStatus: string;
  orgId: number;
  startDate: string | null;
}

interface Announcement {
  id: number;
  tournamentId: number;
  orgId: number;
  tournamentName: string;
  body: string;
  type: "general" | "delay" | "rule" | "results";
  authorName: string | null;
  sentAt: string;
}

interface FeedItem {
  id: string;
  type: "scoring_event" | "achievement" | "media" | "round_complete";
  playerName: string;
  profileImage: string | null;
  title: string;
  subtitle: string | null;
  tournamentId: number | null;
  tournamentName: string | null;
  occurredAt: string;
  meta?: Record<string, unknown>;
}

interface PeerReviewInvite {
  id: number;
  token: string;
  invitedAt: string;
  seenAt: string | null;
  expiresAt: string | null;
  caseId: number;
  caseKind: string;
  caseStatus: string;
  periodLabel: string | null;
  subjectName: string | null;
  orgName: string | null;
}

interface NoticeFeedItem {
  id: number;
  title: string;
  body: string;
  imageUrl: string | null;
  isPinned: boolean;
  isImportant: boolean;
  isSponsored: boolean;
  sponsorUrl: string | null;
  categoryName: string | null;
  categoryColor: string | null;
  publishedAt: string | null;
  isRead?: boolean;
}

type TypeStyle = { border: string; text: string; bg: string; label: string };

const TYPE_STYLES: Record<string, TypeStyle> = {
  general: { border: "#3b82f6", text: "#93c5fd", bg: "rgba(59,130,246,0.12)", label: "General" },
  delay:   { border: "#eab308", text: "#fde047", bg: "rgba(234,179,8,0.12)",  label: "Delay" },
  rule:    { border: "#f97316", text: "#fdba74", bg: "rgba(249,115,22,0.12)", label: "Rule" },
  results: { border: "#22c55e", text: "#86efac", bg: "rgba(34,197,94,0.12)",  label: "Results" },
};

// Task #2059 — defer to the shared `formatRelativeTime` helper so this
// label uses Intl.RelativeTimeFormat, which has every CLDR plural bucket
// (zero/one/two/few/many/other) baked in. The previous
// `updates.{justNow,minutesAgo,hoursAgo,daysAgo}` JSON keys only had
// `_one`/`_other` plurals, leaking English copy into Arabic counts
// 2..10 — the exact regression Task #1659 fixed.
function relativeTime(iso: string): string {
  return formatRelativeTime(iso);
}

function initials(name: string): string {
  return name.split(" ").map((w) => w[0] ?? "").slice(0, 2).join("").toUpperCase();
}

function Avatar({ name, profileImage, size = 38 }: { name: string; profileImage?: string | null; size?: number }) {
  const seed = name.charCodeAt(0) + (name.charCodeAt(1) ?? 0);
  const colors = ["#C9A84C", "#3B82F6", "#EF4444", "#22c55e", "#A855F7", "#F97316"];
  const bg = colors[seed % colors.length]!;

  if (profileImage) {
    return (
      <Image
        source={{ uri: profileImage }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        defaultSource={undefined}
        onError={undefined}
      />
    );
  }

  return (
    <View
      style={{
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: bg + "33", borderWidth: 1, borderColor: bg + "88",
        alignItems: "center", justifyContent: "center", flexShrink: 0,
      }}
    >
      <Text style={{ fontSize: size * 0.36, fontWeight: "700", color: bg }}>{initials(name)}</Text>
    </View>
  );
}

function feedConfig(type: FeedItem["type"], title: string): { iconName: FeatherIconName; color: string; bg: string } {
  if (type === "achievement") return { iconName: "award", color: "#C9A84C", bg: "rgba(201,168,76,0.15)" };
  if (type === "media") return { iconName: "image", color: "#a855f7", bg: "rgba(168,85,247,0.15)" };
  if (type === "round_complete") return { iconName: "check-circle", color: "#22c55e", bg: "rgba(34,197,94,0.12)" };
  if (title.includes("Hole-in-One")) return { iconName: "target", color: "#F5C842", bg: "rgba(245,200,66,0.15)" };
  if (title.includes("Eagle") || title.includes("Albatross")) return { iconName: "zap", color: "#F5C842", bg: "rgba(245,200,66,0.15)" };
  return { iconName: "trending-down", color: "#EF4444", bg: "rgba(239,68,68,0.12)" };
}

function FeedCardSkeleton() {
  return (
    <View style={[styles.feedCard, { opacity: 0.4 }]}>
      <View style={[styles.avatarWrap, { backgroundColor: Colors.border }]} />
      <View style={{ flex: 1, gap: 6 }}>
        <View style={{ height: 14, backgroundColor: Colors.border, borderRadius: 4, width: "75%" }} />
        <View style={{ height: 11, backgroundColor: Colors.border, borderRadius: 4, width: "50%" }} />
      </View>
    </View>
  );
}

function FeedCard({ item, onPress }: { item: FeedItem; onPress?: () => void }) {
  const { t } = useTranslation("updates");
  const { iconName, color, bg } = feedConfig(item.type, item.title);
  return (
    <TouchableOpacity
      activeOpacity={onPress ? 0.75 : 1}
      onPress={onPress}
      style={styles.feedCard}
    >
      <View style={styles.avatarWrap}>
        <Avatar name={item.playerName} profileImage={item.profileImage} size={38} />
        <View style={[styles.feedTypeBadge, { backgroundColor: bg, borderColor: color + "66" }]}>
          <Feather name={iconName} size={10} color={color} />
        </View>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.feedTitle} numberOfLines={2}>{item.title}</Text>
        <View style={styles.feedMeta}>
          {item.tournamentName && (
            <Text style={styles.feedTournament} numberOfLines={1}>{item.tournamentName}</Text>
          )}
          {item.subtitle && (
            <Text style={styles.feedSubtitle}>{item.subtitle}</Text>
          )}
          <Text style={styles.feedTime}>{relativeTime(item.occurredAt)}</Text>
        </View>
      </View>
      {onPress && <Feather name="chevron-right" size={16} color={Colors.muted} style={{ alignSelf: "center", flexShrink: 0 }} />}
    </TouchableOpacity>
  );
}

function AnnouncementCard({ item, isUnread }: { item: Announcement; isUnread: boolean }) {
  const { t } = useTranslation("updates");
  const ts = TYPE_STYLES[item.type] ?? TYPE_STYLES.general!;
  const date = new Date(item.sentAt);
  const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dateStr = date.toLocaleDateString([], { month: "short", day: "numeric" });

  return (
    <View
      style={[
        styles.card,
        { borderLeftColor: ts.border, backgroundColor: ts.bg },
        isUnread && styles.cardUnread,
      ]}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.typeBadge, { borderColor: ts.border }]}>
          <Text style={[styles.typeLabel, { color: ts.text }]}>{t(`typeLabels.${item.type}`)}</Text>
        </View>
        <Text style={styles.cardTournament} numberOfLines={1}>{item.tournamentName}</Text>
        {isUnread && <View style={styles.unreadDot} />}
      </View>
      <Text style={styles.cardBody}>{item.body}</Text>
      <View style={styles.cardFooter}>
        <Feather name="user" size={11} color={Colors.textSecondary} />
        <Text style={styles.cardMeta}>{item.authorName ?? t("organizer")}</Text>
        <Text style={styles.cardMeta}> · </Text>
        <Feather name="clock" size={11} color={Colors.textSecondary} />
        <Text style={styles.cardMeta}> {dateStr} {timeStr}</Text>
      </View>
    </View>
  );
}

const PEER_KIND_KEYS: Record<string, string> = {
  anomalous: "peerReview.kinds.anomalous",
  not_posted: "peerReview.kinds.not_posted",
  exceptional: "peerReview.kinds.exceptional",
  annual: "peerReview.kinds.annual",
};

function PeerReviewInviteCard({ invite, onPress }: { invite: PeerReviewInvite; onPress: () => void }) {
  const { t } = useTranslation("updates");
  const kindLabel = PEER_KIND_KEYS[invite.caseKind] ? t(PEER_KIND_KEYS[invite.caseKind]!) : invite.caseKind;
  const subject = invite.subjectName ?? t("peerReview.subjectFallback");
  const org = invite.orgName ?? t("peerReview.orgFallback");
  const period = invite.periodLabel ? t("peerReview.periodSuffix", { period: invite.periodLabel }) : "";
  const isUnseen = !invite.seenAt;
  return (
    <TouchableOpacity
      activeOpacity={0.78}
      onPress={onPress}
      testID={`peer-invite-card-${invite.id}`}
      style={[
        styles.card,
        { borderLeftColor: "#a855f7", backgroundColor: isUnseen ? "rgba(168,85,247,0.10)" : "rgba(168,85,247,0.04)" },
        isUnseen && styles.cardUnread,
      ]}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.typeBadge, { borderColor: "#a855f7" }]}>
          <Text style={[styles.typeLabel, { color: "#d8b4fe" }]}>{t("peerReview.label")}</Text>
        </View>
        <Text style={styles.cardTournament} numberOfLines={1}>{kindLabel}</Text>
        {isUnseen && <View testID={`peer-invite-unread-dot-${invite.id}`} style={styles.unreadDot} />}
      </View>
      <Text style={styles.cardBody}>
        {t("peerReview.inviteBody", { org, subject, period })}
      </Text>
      <View style={styles.cardFooter}>
        <Feather name="clock" size={11} color={Colors.textSecondary} />
        <Text style={styles.cardMeta}> {t("peerReview.invited", { time: relativeTime(invite.invitedAt) })}</Text>
        {/* Once the invite has been seen, surface a "Seen X ago" status next
            to the invited timestamp. The card otherwise has no textual cue
            that it has been opened — only the unread dot disappears and the
            background dims — and any text we add here has to round-trip
            through `t()` so all 21 locale bundles can translate it. */}
        {invite.seenAt && (
          <>
            <Text style={styles.cardMeta}> · </Text>
            <Feather name="check" size={11} color="#86efac" />
            <Text
              testID={`peer-invite-seen-${invite.id}`}
              style={styles.cardMeta}
            >
              {" "}{t("peerReview.seen", { time: relativeTime(invite.seenAt) })}
            </Text>
          </>
        )}
        {invite.expiresAt && (
          <>
            <Text style={styles.cardMeta}> · </Text>
            <Feather name="alert-circle" size={11} color={Colors.textSecondary} />
            <Text style={styles.cardMeta}> {t("peerReview.expires", { date: new Date(invite.expiresAt).toLocaleDateString(getLocale(), { month: "short", day: "numeric" }) })}</Text>
          </>
        )}
        <View style={{ flex: 1 }} />
        <Feather name="chevron-right" size={14} color="#d8b4fe" />
      </View>
    </TouchableOpacity>
  );
}

function EmptyState({ isAuthenticated, tab }: { isAuthenticated: boolean; tab: "announcements" | "activity" }) {
  const { t } = useTranslation("updates");
  return (
    <View style={styles.emptyState}>
      <Feather name={tab === "activity" ? "activity" : "bell"} size={48} color={Colors.muted} />
      <Text style={styles.emptyTitle}>
        {!isAuthenticated
          ? t("signInTitle")
          : tab === "activity"
          ? t("noActivityTitle")
          : t("noAnnouncementsTitle")}
      </Text>
      <Text style={styles.emptySubtitle}>
        {!isAuthenticated
          ? t("signInSub")
          : tab === "activity"
          ? t("noActivitySub")
          : t("noAnnouncementsSub")}
      </Text>
    </View>
  );
}

function RulesAssistantBanner({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation("updates");
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.82} style={styles.rulesBanner}>
      <View style={styles.rulesBannerIcon}>
        <Feather name="book-open" size={22} color="#C9A84C" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rulesBannerTitle}>{t("rulesTitle")}</Text>
        <Text style={styles.rulesBannerSub}>{t("rulesSub")}</Text>
      </View>
      <Feather name="chevron-right" size={18} color="#C9A84C" />
    </TouchableOpacity>
  );
}

export default function UpdatesScreen() {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation("updates");
  const isWeb = Platform.OS === "web";
  const topPadding = isWeb ? 67 : insets.top;

  const { isAuthenticated, token, user } = useAuth();
  const { lastSeenAt, setUnreadCount, markAllRead } = useUnread();
  const { refresh: refreshMoreBadges } = useMoreBadges();
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<"announcements" | "activity" | "notices">("announcements");
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);
  const [noticeItems, setNoticeItems] = useState<NoticeFeedItem[]>([]);
  const [peerInvites, setPeerInvites] = useState<PeerReviewInvite[]>([]);
  const [noticesLoading, setNoticesLoading] = useState(true);
  const [selectedNotice, setSelectedNotice] = useState<NoticeFeedItem | null>(null);
  const [noticeSearch, setNoticeSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [feedLoading, setFeedLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const markedReadRef = React.useRef<Set<number>>(new Set());

  const fetchAnnouncements = useCallback(async (showRefreshing = false) => {
    if (!isAuthenticated || !token) {
      setAnnouncements([]);
      setUnreadCount(0);
      setLoading(false);
      return;
    }

    if (showRefreshing) setRefreshing(true);

    try {
      setError(null);
      const myRes = await fetch(`${BASE_URL}/api/portal/my-tournaments`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!myRes.ok) throw new Error("Failed to load tournaments");
      const myTournaments: MyTournament[] = await myRes.json();

      if (myTournaments.length === 0) {
        setAnnouncements([]);
        setUnreadCount(0);
        return;
      }

      const results = await Promise.allSettled(
        myTournaments.map(async (t) => {
          const res = await fetch(
            `${BASE_URL}/api/organizations/${t.orgId}/tournaments/${t.tournamentId}/announcements`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          if (!res.ok) return [];
          const anns = await res.json();
          return (anns as Omit<Announcement, "tournamentName" | "orgId">[]).map((a) => ({
            ...a,
            orgId: t.orgId,
            tournamentName: t.tournamentName,
          }));
        })
      );

      const all: Announcement[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") all.push(...r.value);
      }

      all.sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
      setAnnouncements(all);

      const unread = lastSeenAt > 0
        ? all.filter((a) => new Date(a.sentAt).getTime() > lastSeenAt).length
        : all.length;
      setUnreadCount(unread);
    } catch {
      setError(t("couldNotLoad"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isAuthenticated, token, lastSeenAt, setUnreadCount]);

  const fetchFeed = useCallback(async (showRefreshing = false) => {
    if (!isAuthenticated || !token) {
      setFeedItems([]);
      setFeedLoading(false);
      return;
    }
    if (showRefreshing) setRefreshing(true);
    try {
      const res = await fetch(`${BASE_URL}/api/portal/feed`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setFeedItems(await res.json());
    } catch { /* ignore */ } finally {
      setFeedLoading(false);
      setRefreshing(false);
    }
  }, [isAuthenticated, token]);

  const handleOpenPeerInvite = useCallback((invite: PeerReviewInvite) => {
    if (!invite.seenAt) {
      // Optimistically settle the unread dot so the card updates instantly,
      // then tell the server. If the server call fails the next poll will
      // re-hydrate the true state.
      setPeerInvites(prev => prev.map(i => i.id === invite.id ? { ...i, seenAt: new Date().toISOString() } : i));
      if (token) {
        fetch(`${BASE_URL}/api/portal/handicap/peer-invites/${invite.id}/seen`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => { /* best-effort */ });
      }
    }
    router.push({ pathname: "/peer-review/[token]", params: { token: invite.token } } as never);
  }, [token, router]);

  const fetchPeerInvites = useCallback(async () => {
    if (!isAuthenticated || !token) {
      setPeerInvites([]);
      return;
    }
    try {
      const res = await fetch(`${BASE_URL}/api/portal/handicap/my-peer-invites`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setPeerInvites(await res.json());
    } catch { /* ignore */ }
  }, [isAuthenticated, token]);

  const fetchNotices = useCallback(async (showRefreshing = false) => {
    if (!isAuthenticated || !token) {
      setNoticeItems([]);
      setNoticesLoading(false);
      return;
    }
    if (showRefreshing) setRefreshing(true);
    const orgId = user?.organizationId;
    if (!orgId) { setNoticesLoading(false); setRefreshing(false); return; }
    try {
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/notice-board/feed`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setNoticeItems(await res.json());
    } catch { /* ignore */ } finally {
      setNoticesLoading(false);
      setRefreshing(false);
    }
  }, [isAuthenticated, token, user?.organizationId]);

  const handleOpenNotice = useCallback(async (item: NoticeFeedItem) => {
    setSelectedNotice(item);
    const orgId = user?.organizationId;
    if (!item.isRead && token && orgId) {
      try {
        await fetch(`${BASE_URL}/api/organizations/${orgId}/notice-board/articles/${item.id}/read`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        setNoticeItems(prev => prev.map(a => a.id === item.id ? { ...a, isRead: true } : a));
      } catch { /* ignore */ }
    }
  }, [token, user?.organizationId]);

  useEffect(() => {
    setLoading(true);
    setFeedLoading(true);
    setNoticesLoading(true);
    void fetchAnnouncements();
    void fetchFeed();
    void fetchNotices();
    void fetchPeerInvites();

    const pollTimer = setInterval(() => {
      void fetchAnnouncements();
      void fetchFeed();
      void fetchNotices();
      void fetchPeerInvites();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(pollTimer);
  }, [fetchAnnouncements, fetchFeed, fetchNotices, fetchPeerInvites]);

  // One refresh per focus event: settle the local "last seen" marker
  // (markAllRead persists kharagolf_updates_last_seen via AsyncStorage),
  // then ask the More-menu badge aggregator to re-fetch so its per-row
  // Updates count collapses immediately. Deps intentionally exclude
  // `announcements` so polling-driven list churn does not re-fire this.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        await markAllRead();
        if (!cancelled) refreshMoreBadges();
      })();
      return () => { cancelled = true; };
    }, [markAllRead, refreshMoreBadges])
  );

  // Mark currently-loaded announcements read on the server. Re-runs when
  // the announcement list changes (initial load or polling), but uses a
  // ref to skip already-marked ids so each is POSTed at most once.
  useFocusEffect(
    useCallback(() => {
      if (!token || announcements.length === 0) return;
      const toMark = announcements.filter((a) => !markedReadRef.current.has(a.id));
      for (const ann of toMark) {
        markedReadRef.current.add(ann.id);
        fetch(
          `${BASE_URL}/api/organizations/${ann.orgId}/tournaments/${ann.tournamentId}/announcements/${ann.id}/read`,
          { method: "POST", headers: { Authorization: `Bearer ${token}` } },
        ).catch(() => {});
      }
    }, [token, announcements])
  );

  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener(() => {
      void fetchAnnouncements();
      void fetchFeed();
      void fetchPeerInvites();
    });
    return () => sub.remove();
  }, [fetchAnnouncements, fetchFeed, fetchPeerInvites]);

  const onRefresh = () => {
    if (activeTab === "activity") fetchFeed(true);
    else if (activeTab === "notices") fetchNotices(true);
    else { fetchAnnouncements(true); void fetchPeerInvites(); }
  };

  const isActiveLoading = activeTab === "activity" ? feedLoading : activeTab === "notices" ? noticesLoading : loading;

  function handleFeedItemPress(item: FeedItem) {
    if (item.tournamentId == null) return;
    router.push({
      pathname: "/(tabs)/leaderboard",
      params: {
        tournamentId: String(item.tournamentId),
        tournamentName: item.tournamentName ?? "",
      },
    } as never);
  }

  return (
    <View style={[styles.container, { paddingTop: topPadding }]}>
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>{t("title")}</Text>
          <Text style={styles.headerSubtitle}>
            {activeTab === "activity" ? t("subtitleActivity") : t("subtitleAnnouncements")}
          </Text>
        </View>
        <TouchableOpacity style={styles.refreshBtn} onPress={onRefresh}>
          <Feather name="refresh-cw" size={18} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tabBtn, activeTab === "announcements" && styles.tabBtnActive]}
          onPress={() => setActiveTab("announcements")}
          activeOpacity={0.8}
        >
          <Feather name="bell" size={14} color={activeTab === "announcements" ? "#C9A84C" : Colors.textSecondary} />
          <Text style={[styles.tabLabel, activeTab === "announcements" && styles.tabLabelActive]}>
            {t("tabAnnouncements")}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabBtn, activeTab === "activity" && styles.tabBtnActive]}
          onPress={() => setActiveTab("activity")}
          activeOpacity={0.8}
        >
          <Feather name="activity" size={14} color={activeTab === "activity" ? "#C9A84C" : Colors.textSecondary} />
          <Text style={[styles.tabLabel, activeTab === "activity" && styles.tabLabelActive]}>
            {t("tabActivity")}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabBtn, activeTab === "notices" && styles.tabBtnActive]}
          onPress={() => setActiveTab("notices")}
          activeOpacity={0.8}
        >
          <Feather name="file-text" size={14} color={activeTab === "notices" ? "#C9A84C" : Colors.textSecondary} />
          <Text style={[styles.tabLabel, activeTab === "notices" && styles.tabLabelActive]}>
            {t("tabNotices")}
          </Text>
        </TouchableOpacity>
      </View>

      <RulesAssistantBanner onPress={() => router.push("/(tabs)/rules")} />

      {isActiveLoading ? (
        <FlatList
          data={[1, 2, 3, 4, 5]}
          keyExtractor={(n) => String(n)}
          renderItem={() => <FeedCardSkeleton />}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={<View style={{ height: 12 }} />}
        />
      ) : error && activeTab === "announcements" ? (
        <View style={styles.emptyState}>
          <Feather name="wifi-off" size={40} color={Colors.muted} />
          <Text style={styles.emptyTitle}>{t("connectionError")}</Text>
          <Text style={styles.emptySubtitle}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={onRefresh}>
            <Text style={styles.retryText}>{t("retry")}</Text>
          </TouchableOpacity>
        </View>
      ) : activeTab === "announcements" ? (
        announcements.length === 0 && peerInvites.length === 0 ? (
          <EmptyState isAuthenticated={isAuthenticated} tab="announcements" />
        ) : (
          <FlatList
            data={announcements}
            keyExtractor={(item) => `${item.tournamentId}-${item.id}`}
            renderItem={({ item }) => (
              <AnnouncementCard
                item={item}
                isUnread={lastSeenAt > 0 && new Date(item.sentAt).getTime() > lastSeenAt}
              />
            )}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={Colors.primary}
                colors={[Colors.primary]}
              />
            }
            ListHeaderComponent={
              <View>
                {peerInvites.length > 0 && (
                  <View style={{ marginBottom: 16 }}>
                    <Text style={styles.listHeader}>{t("peerReview.requestsHeader")}</Text>
                    {peerInvites.map((inv) => (
                      <PeerReviewInviteCard
                        key={inv.id}
                        invite={inv}
                        onPress={() => handleOpenPeerInvite(inv)}
                      />
                    ))}
                  </View>
                )}
                {announcements.length > 0 && (
                  <Text style={styles.listHeader}>
                    {t("announcementsCount", { count: announcements.length })}
                  </Text>
                )}
              </View>
            }
          />
        )
      ) : activeTab === "notices" ? (
        <>
          {/* Notice detail modal */}
          <Modal
            visible={selectedNotice !== null}
            animationType="slide"
            presentationStyle="pageSheet"
            onRequestClose={() => setSelectedNotice(null)}
          >
            {selectedNotice && (
              <View style={{ flex: 1, backgroundColor: Colors.background }}>
                <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: insets.top + 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.08)" }}>
                  <TouchableOpacity onPress={() => setSelectedNotice(null)} style={{ marginRight: 12 }}>
                    <Feather name="x" size={22} color={Colors.text} />
                  </TouchableOpacity>
                  <Text style={{ flex: 1, fontSize: 16, fontWeight: "700", color: Colors.text }} numberOfLines={1}>{selectedNotice.title}</Text>
                </View>
                <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 18, gap: 14 }} showsVerticalScrollIndicator={false}>
                  {/* Badges */}
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                    {selectedNotice.isPinned && (
                      <View style={[styles.noticeBadge, { backgroundColor: "rgba(201,168,76,0.15)", borderColor: "rgba(201,168,76,0.3)" }]}>
                        <Feather name="bookmark" size={9} color="#C9A84C" />
                        <Text style={[styles.noticeBadgeText, { color: "#C9A84C" }]}>{t("pinned")}</Text>
                      </View>
                    )}
                    {selectedNotice.isImportant && (
                      <View style={[styles.noticeBadge, { backgroundColor: "rgba(234,179,8,0.15)", borderColor: "rgba(234,179,8,0.3)" }]}>
                        <Feather name="alert-circle" size={9} color="#fde047" />
                        <Text style={[styles.noticeBadgeText, { color: "#fde047" }]}>{t("important")}</Text>
                      </View>
                    )}
                    {selectedNotice.isSponsored && (
                      <View style={[styles.noticeBadge, { backgroundColor: "rgba(249,115,22,0.15)", borderColor: "rgba(249,115,22,0.3)" }]}>
                        <Feather name="star" size={9} color="#fdba74" />
                        <Text style={[styles.noticeBadgeText, { color: "#fdba74" }]}>{t("sponsored")}</Text>
                      </View>
                    )}
                    {selectedNotice.categoryName && (
                      <View style={[styles.noticeBadge, { backgroundColor: (selectedNotice.categoryColor ?? "#C9A84C") + "22", borderColor: (selectedNotice.categoryColor ?? "#C9A84C") + "44" }]}>
                        <Text style={[styles.noticeBadgeText, { color: selectedNotice.categoryColor ?? "#C9A84C" }]}>{selectedNotice.categoryName}</Text>
                      </View>
                    )}
                  </View>
                  {/* Time */}
                  <Text style={{ fontSize: 12, color: Colors.muted }}>{relativeTime(selectedNotice.publishedAt ?? new Date().toISOString())}</Text>
                  {/* Hero image */}
                  {selectedNotice.imageUrl && (
                    <Image source={{ uri: selectedNotice.imageUrl }} style={{ width: "100%", height: 180, borderRadius: 10 }} resizeMode="cover" />
                  )}
                  {/* Body (strip HTML tags for native rendering) */}
                  <Text style={{ fontSize: 15, color: Colors.text, lineHeight: 24 }}>
                    {selectedNotice.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}
                  </Text>
                  {/* Sponsor CTA */}
                  {selectedNotice.isSponsored && selectedNotice.sponsorUrl && (
                    <TouchableOpacity
                      style={{ backgroundColor: "rgba(249,115,22,0.2)", borderWidth: 1, borderColor: "rgba(249,115,22,0.4)", borderRadius: 10, padding: 14, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 }}
                      onPress={() => {
                        if (!selectedNotice.sponsorUrl) return;
                        const orgId = user?.organizationId;
                        if (orgId && token) {
                          void fetch(`${BASE_URL}/api/organizations/${orgId}/notice-board/articles/${selectedNotice.id}/click`, {
                            method: 'POST',
                            headers: { Authorization: `Bearer ${token}` },
                          });
                        }
                        void Linking.openURL(selectedNotice.sponsorUrl);
                      }}
                    >
                      <Feather name="external-link" size={16} color="#fdba74" />
                      <Text style={{ color: "#fdba74", fontWeight: "700", fontSize: 14 }}>{t("visitSponsor")}</Text>
                    </TouchableOpacity>
                  )}
                </ScrollView>
              </View>
            )}
          </Modal>

          {/* Search bar */}
          <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 10, paddingHorizontal: 10, height: 38, borderWidth: 1, borderColor: "rgba(255,255,255,0.1)" }}>
              <Feather name="search" size={14} color={Colors.muted} />
              <TextInput
                value={noticeSearch}
                onChangeText={setNoticeSearch}
                placeholder={t("searchNotices")}
                placeholderTextColor={Colors.muted}
                style={{ flex: 1, marginLeft: 8, color: Colors.text, fontSize: 14 }}
              />
              {noticeSearch.length > 0 && (
                <TouchableOpacity onPress={() => setNoticeSearch('')}>
                  <Feather name="x-circle" size={14} color={Colors.muted} />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {noticeItems.filter(n => !noticeSearch || n.title.toLowerCase().includes(noticeSearch.toLowerCase()) || n.body.toLowerCase().includes(noticeSearch.toLowerCase())).length === 0 ? (
            <View style={styles.emptyState}>
              <Feather name="file-text" size={40} color={Colors.muted} />
              <Text style={styles.emptyTitle}>{noticeSearch ? t("noResultsFound") : t("noNoticesYet")}</Text>
              <Text style={styles.emptySubtitle}>{noticeSearch ? t("noResultsSub") : t("noNoticesSub")}</Text>
            </View>
          ) : (
            <FlatList
              data={noticeItems.filter(n => !noticeSearch || n.title.toLowerCase().includes(noticeSearch.toLowerCase()) || n.body.toLowerCase().includes(noticeSearch.toLowerCase()))}
              keyExtractor={(item) => String(item.id)}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.noticeCard, item.isPinned && styles.noticePinned, !item.isRead && styles.noticeUnread]}
                  onPress={() => void handleOpenNotice(item)}
                  activeOpacity={0.75}
                >
                  {item.imageUrl ? (
                    <Image source={{ uri: item.imageUrl }} style={{ width: "100%", height: 140, borderTopLeftRadius: 12, borderTopRightRadius: 12 }} resizeMode="cover" />
                  ) : null}
                  <View style={styles.noticeBody}>
                    <View style={styles.noticeHeader}>
                      {!item.isRead && <View style={styles.noticeDot} />}
                      {item.isPinned && (
                        <View style={styles.noticeBadge}>
                          <Feather name="bookmark" size={9} color="#C9A84C" />
                          <Text style={[styles.noticeBadgeText, { color: "#C9A84C" }]}>{t("pinned")}</Text>
                        </View>
                      )}
                      {item.isImportant && (
                        <View style={[styles.noticeBadge, { backgroundColor: "rgba(234,179,8,0.15)", borderColor: "rgba(234,179,8,0.3)" }]}>
                          <Feather name="alert-circle" size={9} color="#fde047" />
                          <Text style={[styles.noticeBadgeText, { color: "#fde047" }]}>{t("important")}</Text>
                        </View>
                      )}
                      {item.categoryName && (
                        <View style={[styles.noticeBadge, { backgroundColor: (item.categoryColor ?? "#C9A84C") + "22", borderColor: (item.categoryColor ?? "#C9A84C") + "44" }]}>
                          <Text style={[styles.noticeBadgeText, { color: item.categoryColor ?? "#C9A84C" }]}>{item.categoryName}</Text>
                        </View>
                      )}
                    </View>
                    <Text style={styles.noticeTitle}>{item.title}</Text>
                    <Text style={styles.noticeText} numberOfLines={3}>{item.body.replace(/<[^>]+>/g, "")}</Text>
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
                      <Text style={styles.noticeTime}>{relativeTime(item.publishedAt ?? new Date().toISOString())}</Text>
                      <Text style={{ fontSize: 11, color: Colors.primary, fontWeight: "600" }}>{t("readMore")}</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              )}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  tintColor={Colors.primary}
                  colors={[Colors.primary]}
                />
              }
              ListHeaderComponent={
                <Text style={styles.listHeader}>
                  {t("noticesCount", { count: noticeItems.filter(n => !noticeSearch || n.title.toLowerCase().includes(noticeSearch.toLowerCase()) || n.body.toLowerCase().includes(noticeSearch.toLowerCase())).length })}
                </Text>
              }
            />
          )}
        </>
      ) : feedItems.length === 0 ? (
        <EmptyState isAuthenticated={isAuthenticated} tab="activity" />
      ) : (
        <FlatList
          data={feedItems}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <FeedCard
              item={item}
              onPress={item.tournamentId != null ? () => handleFeedItemPress(item) : undefined}
            />
          )}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={Colors.primary}
              colors={[Colors.primary]}
            />
          }
          ListHeaderComponent={
            <Text style={styles.listHeader}>
              {t("feedCount", { count: feedItems.length })}
            </Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "700",
    color: Colors.text,
  },
  headerSubtitle: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  refreshBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: Colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  tabBar: {
    flexDirection: "row",
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 2,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 4,
    gap: 4,
  },
  tabBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 9,
  },
  tabBtnActive: {
    backgroundColor: "rgba(201,168,76,0.15)",
    borderWidth: 1,
    borderColor: "rgba(201,168,76,0.25)",
  },
  tabLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.textSecondary,
  },
  tabLabelActive: {
    color: "#C9A84C",
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 120,
  },
  listHeader: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginBottom: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  card: {
    borderRadius: 12,
    borderLeftWidth: 3,
    padding: 14,
    marginBottom: 10,
    backgroundColor: Colors.surface,
  },
  cardUnread: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
    flexWrap: "wrap",
  },
  typeBadge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  typeLabel: {
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  cardTournament: {
    fontSize: 12,
    color: Colors.textSecondary,
    flex: 1,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.primary,
  },
  cardBody: {
    fontSize: 14,
    color: Colors.text,
    lineHeight: 20,
    marginBottom: 10,
  },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  cardMeta: {
    fontSize: 11,
    color: Colors.textSecondary,
  },
  feedCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: Colors.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  avatarWrap: {
    position: "relative",
    width: 38,
    height: 38,
    flexShrink: 0,
  },
  feedTypeBadge: {
    position: "absolute",
    bottom: -2,
    right: -4,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Colors.surface,
  },
  feedTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.text,
    lineHeight: 18,
    marginBottom: 3,
  },
  feedMeta: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 5,
  },
  feedTournament: {
    fontSize: 11,
    color: "#C9A84C",
    fontWeight: "500",
    flexShrink: 1,
  },
  feedSubtitle: {
    fontSize: 11,
    color: Colors.textSecondary,
  },
  feedTime: {
    fontSize: 11,
    color: Colors.muted,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: Colors.text,
    textAlign: "center",
  },
  emptySubtitle: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: "center",
    lineHeight: 20,
  },
  retryBtn: {
    marginTop: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: Colors.primary,
    borderRadius: 8,
  },
  retryText: {
    color: "#fff",
    fontWeight: "600",
    fontSize: 14,
  },
  rulesBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    backgroundColor: "rgba(201,168,76,0.08)",
    borderWidth: 1,
    borderColor: "rgba(201,168,76,0.25)",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rulesBannerIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(201,168,76,0.14)",
    alignItems: "center",
    justifyContent: "center",
  },
  rulesBannerTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#C9A84C",
    marginBottom: 2,
  },
  rulesBannerSub: {
    fontSize: 12,
    color: Colors.textSecondary,
    lineHeight: 16,
  },
  noticeCard: {
    marginHorizontal: 16,
    marginVertical: 6,
    backgroundColor: Colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.07)",
    overflow: "hidden",
  },
  noticePinned: {
    borderColor: "rgba(201,168,76,0.3)",
  },
  noticeUnread: {
    borderColor: "rgba(201,168,76,0.25)",
    backgroundColor: "rgba(201,168,76,0.04)",
  },
  noticeImage: {
    width: "100%",
  },
  noticeBody: {
    padding: 14,
  },
  noticeHeader: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 8,
  },
  noticeDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "#C9A84C",
  },
  noticeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
    backgroundColor: "rgba(201,168,76,0.12)",
    borderWidth: 1,
    borderColor: "rgba(201,168,76,0.3)",
  },
  noticeBadgeText: {
    fontSize: 10,
    fontWeight: "600",
    color: "#C9A84C",
  },
  noticeTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: Colors.text,
    marginBottom: 6,
    lineHeight: 21,
  },
  noticeText: {
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 19,
    marginBottom: 10,
  },
  noticeTime: {
    fontSize: 11,
    color: Colors.muted,
  },
});
