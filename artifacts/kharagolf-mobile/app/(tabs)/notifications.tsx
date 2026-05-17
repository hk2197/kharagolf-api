import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  Alert,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/context/auth";
import { useUnread } from "@/context/unread";
import { useMoreBadges } from "@/context/moreBadges";
import Colors from "@/constants/colors";
import { fetchPortal, postPortal } from "@/utils/api";
import { getLocale } from "@/i18n";

const GOLD = "#C9A84C";

interface NotificationItem {
  id: number;
  caseId: number;
  organizationId: number;
  orgName: string | null;
  event: "opened" | "decided" | "closed" | "reopened" | "peer_responded" | string;
  title: string;
  body: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  readAt: string | null;
  caseStatus: string | null;
  caseKind: string | null;
  deepLink: string;
}

interface ListResponse {
  unreadCount: number;
  items: NotificationItem[];
  // Cursor pagination (Task #1685): id of the last item in the page when
  // older items may exist, otherwise null. Older API revisions that don't
  // page may omit this field, in which case we treat the inbox as fully
  // loaded.
  nextCursor?: number | null;
}

const PAGE_SIZE = 25;
// Trigger lazy load when the user scrolls within this many pixels of the
// bottom of the inbox list.
const LOAD_MORE_THRESHOLD_PX = 240;

// Task #1050 — round-robin tie-break inbox row, surfaced from
// /portal/my-tie-break-messages. Recipients who miss/clear the push
// notification still need a way to discover the tie-break match.
interface TieBreakItem {
  id: number;
  organizationId: number;
  orgName: string | null;
  subject: string | null;
  body: string;
  sentAt: string;
  readAt: string | null;
  matchId: number | null;
  tournamentId: number | null;
}

interface TieBreakListResponse {
  unreadCount: number;
  items: TieBreakItem[];
}

// Task #2111 — feed-post inbox row, surfaced from
// /portal/my-feed-post-messages. Mirrors the tie-break shape so members
// who silenced their phone (or whose OS dropped the `feed_post` push
// from Task #1697) still get a persistent "Pat posted to the feed" row
// they can scroll back through. Deep-links to the Feed tab with the
// post id so the originating post can be focused on open.
interface FeedPostItem {
  id: number;
  organizationId: number;
  orgName: string | null;
  subject: string | null;
  body: string;
  sentAt: string;
  readAt: string | null;
  postId: number | null;
}

interface FeedPostListResponse {
  unreadCount: number;
  items: FeedPostItem[];
}

const EVENT_COLOR: Record<string, string> = {
  opened: "#3b82f6",
  decided: "#10b981",
  closed: "#94a3b8",
  reopened: "#f59e0b",
  peer_responded: "#60a5fa",
};

const EVENT_ICON: Record<string, "award" | "message-square"> = {
  peer_responded: "message-square",
};

const TIEBREAK_COLOR = "#f59e0b";
// Task #2111 — distinct accent for the feed-post inbox section so members
// can tell at a glance which inbox row maps to a teammate's new post vs
// the tie-break / committee rows above.
const FEED_POST_COLOR = "#22c55e";

function isCommitteeEvent(event: string): boolean {
  return event === "peer_responded";
}

function parseCaseIdFromDeepLink(deepLink: string | null | undefined): number | null {
  if (!deepLink) return null;
  const m = deepLink.match(/[?&]caseId=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

export default function NotificationsScreen() {
  const { t } = useTranslation(["notifications", "handicapCommittee", "common"]);
  const { token } = useAuth();
  const { setNotifUnreadCount } = useUnread();
  const { refresh: refreshMoreBadges } = useMoreBadges();
  const [data, setData] = useState<ListResponse | null>(null);
  const [tieBreaks, setTieBreaks] = useState<TieBreakListResponse | null>(null);
  const [feedPosts, setFeedPosts] = useState<FeedPostListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Guards re-entrant lazy loads (e.g. multiple onScroll events while a
  // page request is already in flight).
  const loadingMoreRef = useRef(false);

  const eventLabel = useMemo<Record<string, string>>(() => ({
    opened: t("handicapCommittee:events.opened"),
    decided: t("handicapCommittee:events.decided"),
    closed: t("handicapCommittee:events.closed"),
    reopened: t("handicapCommittee:events.reopened"),
    peer_responded: t("handicapCommittee:events.peer_responded"),
  }), [t]);

  const load = useCallback(async () => {
    if (!token) { setLoading(false); setRefreshing(false); return; }
    try {
      const [committee, tb, fp] = await Promise.all([
        fetchPortal<ListResponse>(`/handicap/notifications?limit=${PAGE_SIZE}`, token).catch(() => ({ unreadCount: 0, items: [], nextCursor: null } as ListResponse)),
        fetchPortal<TieBreakListResponse>("/my-tie-break-messages", token).catch(() => ({ unreadCount: 0, items: [] } as TieBreakListResponse)),
        // Task #2111 — feed-post inbox rows mirroring the `feed_post`
        // push fan-out from Task #1697.
        fetchPortal<FeedPostListResponse>("/my-feed-post-messages", token).catch(() => ({ unreadCount: 0, items: [] } as FeedPostListResponse)),
      ]);
      setData(committee);
      setTieBreaks(tb);
      setFeedPosts(fp);
      setNotifUnreadCount((committee.unreadCount ?? 0) + (tb.unreadCount ?? 0) + (fp.unreadCount ?? 0));
    } catch {
      setData({ unreadCount: 0, items: [], nextCursor: null });
      setTieBreaks({ unreadCount: 0, items: [] });
      setFeedPosts({ unreadCount: 0, items: [] });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token, setNotifUnreadCount]);

  // Lazy-load the next page of older committee notifications when the user
  // scrolls toward the bottom of the inbox. Stops once the API reports no
  // continuation cursor (i.e. the last page is on screen).
  const loadMore = useCallback(async () => {
    if (!token) return;
    if (loadingMoreRef.current) return;
    const cursor = data?.nextCursor;
    if (cursor == null) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const page = await fetchPortal<ListResponse>(
        `/handicap/notifications?limit=${PAGE_SIZE}&before=${cursor}`,
        token,
      );
      setData((prev) => {
        if (!prev) return page;
        // De-dupe by id in case a newly-arrived notification shifted the
        // page boundary between requests.
        const seen = new Set(prev.items.map(i => i.id));
        const merged = [...prev.items, ...page.items.filter(i => !seen.has(i.id))];
        return {
          // Trust the freshest unread total the server returns.
          unreadCount: page.unreadCount ?? prev.unreadCount,
          items: merged,
          nextCursor: page.nextCursor ?? null,
        };
      });
    } catch {
      /* best-effort — leave the cursor in place so the user can retry by
         scrolling again. */
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [token, data?.nextCursor]);

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    if (distanceFromBottom <= LOAD_MORE_THRESHOLD_PX) {
      void loadMore();
    }
  }, [loadMore]);

  useEffect(() => { load(); }, [load]);

  // Refresh when the tab regains focus so the badge stays in sync with what
  // the user just opened. After the local load finishes (which settles
  // unreadCount on the server-derived response), poke the More-menu badge
  // aggregator so its per-row Notifications count collapses immediately
  // instead of waiting for the next 30s poll.
  useFocusEffect(useCallback(() => {
    let cancelled = false;
    void (async () => {
      await load();
      if (!cancelled) refreshMoreBadges();
    })();
    return () => { cancelled = true; };
  }, [load, refreshMoreBadges]));

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  const markOneRead = useCallback(async (id: number) => {
    if (!token) return;
    try {
      await postPortal(`/handicap/notifications/${id}/read`, token, {});
      setData((prev) => {
        if (!prev) return prev;
        const wasUnread = prev.items.find((i) => i.id === id && !i.readAt) != null;
        const nextUnread = Math.max(0, prev.unreadCount - (wasUnread ? 1 : 0));
        setNotifUnreadCount(nextUnread + (tieBreaks?.unreadCount ?? 0));
        return {
          unreadCount: nextUnread,
          items: prev.items.map((i) => (i.id === id && !i.readAt ? { ...i, readAt: new Date().toISOString() } : i)),
        };
      });
    } catch {
      /* best-effort */
    }
  }, [token, setNotifUnreadCount, tieBreaks?.unreadCount]);

  const markTieBreakRead = useCallback(async (id: number) => {
    if (!token) return;
    try {
      await postPortal(`/my-tie-break-messages/${id}/read`, token, {});
      setTieBreaks((prev) => {
        if (!prev) return prev;
        const wasUnread = prev.items.find((i) => i.id === id && !i.readAt) != null;
        const nextUnread = Math.max(0, prev.unreadCount - (wasUnread ? 1 : 0));
        setNotifUnreadCount((data?.unreadCount ?? 0) + nextUnread + (feedPosts?.unreadCount ?? 0));
        return {
          unreadCount: nextUnread,
          items: prev.items.map((i) => (i.id === id && !i.readAt ? { ...i, readAt: new Date().toISOString() } : i)),
        };
      });
    } catch {
      /* best-effort */
    }
  }, [token, setNotifUnreadCount, data?.unreadCount, feedPosts?.unreadCount]);

  // Task #2111 — single-row read for the feed-post inbox section.
  // Mirrors `markTieBreakRead`: optimistic local update + best-effort
  // POST. The server endpoint is a no-op when the row is already read,
  // so a transient network failure here is safe to retry on next
  // load/focus.
  const markFeedPostRead = useCallback(async (id: number) => {
    if (!token) return;
    try {
      await postPortal(`/my-feed-post-messages/${id}/read`, token, {});
      setFeedPosts((prev) => {
        if (!prev) return prev;
        const wasUnread = prev.items.find((i) => i.id === id && !i.readAt) != null;
        const nextUnread = Math.max(0, prev.unreadCount - (wasUnread ? 1 : 0));
        setNotifUnreadCount((data?.unreadCount ?? 0) + (tieBreaks?.unreadCount ?? 0) + nextUnread);
        return {
          unreadCount: nextUnread,
          items: prev.items.map((i) => (i.id === id && !i.readAt ? { ...i, readAt: new Date().toISOString() } : i)),
        };
      });
    } catch {
      /* best-effort */
    }
  }, [token, setNotifUnreadCount, data?.unreadCount, tieBreaks?.unreadCount]);

  const markAllRead = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    try {
      const tbUnread = tieBreaks?.items.filter(i => !i.readAt) ?? [];
      // Task #2111 — also flush the feed-post inbox section so the
      // global unread badge actually drops to zero when "Mark all" is
      // tapped (otherwise the badge would still show the unread
      // feed-post rows the user just acknowledged).
      const fpUnread = feedPosts?.items.filter(i => !i.readAt) ?? [];
      await Promise.all([
        postPortal("/handicap/notifications/read-all", token, {}),
        ...tbUnread.map(i => postPortal(`/my-tie-break-messages/${i.id}/read`, token, {}).catch(() => undefined)),
        ...fpUnread.map(i => postPortal(`/my-feed-post-messages/${i.id}/read`, token, {}).catch(() => undefined)),
      ]);
      setData((prev) => prev ? {
        unreadCount: 0,
        items: prev.items.map((i) => i.readAt ? i : { ...i, readAt: new Date().toISOString() }),
      } : prev);
      setTieBreaks((prev) => prev ? {
        unreadCount: 0,
        items: prev.items.map((i) => i.readAt ? i : { ...i, readAt: new Date().toISOString() }),
      } : prev);
      setFeedPosts((prev) => prev ? {
        unreadCount: 0,
        items: prev.items.map((i) => i.readAt ? i : { ...i, readAt: new Date().toISOString() }),
      } : prev);
      setNotifUnreadCount(0);
    } catch {
      Alert.alert(
        t("notifications:markAllErrorTitle"),
        t("notifications:markAllErrorMessage"),
      );
    } finally {
      setBusy(false);
    }
  }, [token, setNotifUnreadCount, tieBreaks?.items, feedPosts?.items, t]);

  const handleOpen = useCallback(async (item: NotificationItem) => {
    if (!item.readAt) await markOneRead(item.id);
    if (isCommitteeEvent(item.event)) {
      const cid = parseCaseIdFromDeepLink(item.deepLink) ?? item.caseId;
      router.push({
        pathname: "/handicap-committee/case/[id]",
        params: { id: String(cid), orgId: String(item.organizationId) },
      } as never);
      return;
    }
    router.push("/handicap-profile" as never);
  }, [markOneRead]);

  const handleOpenTieBreak = useCallback(async (item: TieBreakItem) => {
    if (!item.readAt) await markTieBreakRead(item.id);
    // Same deep-link contract as the push handler in app/_layout.tsx —
    // tournamentId selects the bracket; focusMatchId scrolls/highlights
    // the new tie-break match.
    if (item.tournamentId != null) {
      router.push({
        pathname: "/(tabs)/match-play",
        params: {
          tournamentId: String(item.tournamentId),
          ...(item.matchId != null ? { focusMatchId: String(item.matchId) } : {}),
        },
      } as never);
    } else {
      router.push("/(tabs)/match-play" as never);
    }
  }, [markTieBreakRead]);

  // Task #2111 — open the originating post on the Feed tab. The post
  // id is forwarded as `focusPostId` so the Feed screen can scroll /
  // highlight it; if the row has lost the post id (e.g. the post was
  // deleted) we still drop the user onto the Feed tab so they can see
  // any newer activity.
  const handleOpenFeedPost = useCallback(async (item: FeedPostItem) => {
    if (!item.readAt) await markFeedPostRead(item.id);
    router.push({
      pathname: "/(tabs)/feed",
      params: {
        ...(item.postId != null ? { focusPostId: String(item.postId) } : {}),
        ...(item.organizationId != null ? { orgId: String(item.organizationId) } : {}),
      },
    } as never);
  }, [markFeedPostRead]);

  const items = data?.items ?? [];
  const tieBreakItems = tieBreaks?.items ?? [];
  const feedPostItems = feedPosts?.items ?? [];
  const unread = (data?.unreadCount ?? 0) + (tieBreaks?.unreadCount ?? 0) + (feedPosts?.unreadCount ?? 0);
  const peerResponses = items.filter(i => i.event === "peer_responded");
  const unreadPeerResponses = peerResponses.filter(i => !i.readAt);
  const isEmpty = items.length === 0 && tieBreakItems.length === 0 && feedPostItems.length === 0;
  const canGoBack = router.canGoBack();

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        {canGoBack ? (
          <TouchableOpacity onPress={() => router.back()} style={{ padding: 4 }} accessibilityLabel={t("common:back")}>
            <Feather name="chevron-left" size={24} color={Colors.text} />
          </TouchableOpacity>
        ) : null}
        <View style={{ flex: 1 }}>
          <View style={styles.titleRow}>
            <Feather name="bell" size={18} color={GOLD} />
            <Text style={styles.title}>{t("notifications:title")}</Text>
            {unread > 0 && (
              <View style={styles.unreadBadge}>
                <Text style={styles.unreadBadgeText}>{t("notifications:unreadBadge", { count: unread })}</Text>
              </View>
            )}
          </View>
          <Text style={styles.subtitle}>{t("notifications:subtitle")}</Text>
        </View>
        <TouchableOpacity
          onPress={markAllRead}
          disabled={busy || unread === 0}
          style={[styles.markAllBtn, (busy || unread === 0) && styles.markAllBtnDisabled]}
          accessibilityLabel={t("notifications:markAllAccessibility")}
        >
          <Feather name="check-circle" size={14} color={busy || unread === 0 ? Colors.muted : Colors.text} />
          <Text style={[styles.markAllText, (busy || unread === 0) && styles.markAllTextDisabled]}>{t("notifications:markAll")}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={GOLD} />}
        onScroll={handleScroll}
        scrollEventThrottle={200}
        testID="notifications-scroll"
      >
        {loading ? (
          <LoadingSpinner color={GOLD} style={{ marginTop: 60 }} />
        ) : isEmpty ? (
          <View style={styles.empty}>
            <Feather name="bell-off" size={36} color={Colors.muted} />
            <Text style={styles.emptyTitle}>{t("notifications:emptyTitle")}</Text>
            <Text style={styles.emptyText}>
              {t("notifications:emptyText")}
            </Text>
          </View>
        ) : (
          <View style={{ paddingBottom: 24 }}>
            {peerResponses.length > 0 && (
              <View style={styles.section} testID="section-peer-responses">
                <View style={styles.sectionHeader}>
                  <Feather name="message-square" size={14} color="#60a5fa" />
                  <Text style={styles.sectionTitle}>{t("notifications:peerResponsesHeading")}</Text>
                  {unreadPeerResponses.length > 0 && (
                    <View style={styles.sectionBadge}>
                      <Text style={styles.sectionBadgeText}>{t("notifications:peerResponsesUnread", { count: unreadPeerResponses.length })}</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.sectionHint}>
                  {t("notifications:peerResponsesHint")}
                </Text>
              </View>
            )}
            {tieBreakItems.map((item) => {
              const isUnread = !item.readAt;
              return (
                <TouchableOpacity
                  key={`tiebreak-${item.id}`}
                  style={[styles.row, isUnread && styles.rowUnread]}
                  onPress={() => handleOpenTieBreak(item)}
                  activeOpacity={0.7}
                  testID={`tiebreak-${item.id}`}
                >
                  <View style={[styles.iconWrap, { backgroundColor: `${TIEBREAK_COLOR}22` }]}>
                    <Feather name="flag" size={16} color={TIEBREAK_COLOR} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={styles.rowTitleLine}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {item.subject ?? t("notifications:tieBreakFallbackSubject")}
                      </Text>
                      {isUnread && <View style={styles.unreadDot} />}
                    </View>
                    <View style={[styles.tag, { borderColor: `${TIEBREAK_COLOR}55` }]}>
                      <Text style={[styles.tagText, { color: TIEBREAK_COLOR }]}>{t("notifications:tieBreakLabel")}</Text>
                    </View>
                    <Text style={styles.rowBody}>{item.body}</Text>
                    <Text style={styles.rowMeta}>
                      {new Date(item.sentAt).toLocaleString(getLocale())}
                      {item.orgName ? ` · ${item.orgName}` : ""}
                      {item.matchId != null ? ` · ${t("notifications:matchSuffix", { id: item.matchId })}` : ""}
                    </Text>
                  </View>
                  <Feather name="chevron-right" size={18} color={Colors.muted} />
                </TouchableOpacity>
              );
            })}
            {/* Task #2111 — feed-post inbox rows. Mirrors the tie-break
                section above so a member who silenced their phone (or
                whose OS dropped the `feed_post` push from Task #1697)
                still gets a persistent, scrollable record of the post
                and a tap-to-open deep link onto the Feed tab. */}
            {feedPostItems.map((item) => {
              const isUnread = !item.readAt;
              return (
                <TouchableOpacity
                  key={`feedpost-${item.id}`}
                  style={[styles.row, isUnread && styles.rowUnread]}
                  onPress={() => handleOpenFeedPost(item)}
                  activeOpacity={0.7}
                  testID={`feedpost-${item.id}`}
                >
                  <View style={[styles.iconWrap, { backgroundColor: `${FEED_POST_COLOR}22` }]}>
                    <Feather name="message-circle" size={16} color={FEED_POST_COLOR} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={styles.rowTitleLine}>
                      <Text style={styles.rowTitle} numberOfLines={1}>
                        {item.subject ?? t("notifications:feedPostFallbackSubject")}
                      </Text>
                      {isUnread && <View style={styles.unreadDot} />}
                    </View>
                    <View style={[styles.tag, { borderColor: `${FEED_POST_COLOR}55` }]}>
                      <Text style={[styles.tagText, { color: FEED_POST_COLOR }]}>{t("notifications:feedPostLabel")}</Text>
                    </View>
                    <Text style={styles.rowBody}>{item.body}</Text>
                    <Text style={styles.rowMeta}>
                      {new Date(item.sentAt).toLocaleString(getLocale())}
                      {item.orgName ? ` · ${item.orgName}` : ""}
                      {item.postId != null ? ` · ${t("notifications:feedPostSuffix", { id: item.postId })}` : ""}
                    </Text>
                  </View>
                  <Feather name="chevron-right" size={18} color={Colors.muted} />
                </TouchableOpacity>
              );
            })}
            {items.map((item) => {
              const isUnread = !item.readAt;
              const tone = EVENT_COLOR[item.event] ?? EVENT_COLOR.opened;
              const label = eventLabel[item.event] ?? item.event;
              const iconName = EVENT_ICON[item.event] ?? "award";
              const cid = parseCaseIdFromDeepLink(item.deepLink) ?? item.caseId;
              return (
                <TouchableOpacity
                  key={item.id}
                  style={[styles.row, isUnread && styles.rowUnread]}
                  onPress={() => handleOpen(item)}
                  activeOpacity={0.7}
                  testID={`notification-${item.id}`}
                >
                  <View style={[styles.iconWrap, { backgroundColor: `${tone}22` }]}>
                    <Feather name={iconName} size={16} color={tone} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={styles.rowTitleLine}>
                      <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
                      {isUnread && <View style={styles.unreadDot} />}
                    </View>
                    <View style={[styles.tag, { borderColor: `${tone}55` }]}>
                      <Text style={[styles.tagText, { color: tone }]}>{label}</Text>
                    </View>
                    <Text style={styles.rowBody}>{item.body}</Text>
                    <Text style={styles.rowMeta}>
                      {new Date(item.createdAt).toLocaleString(getLocale())}
                      {item.orgName ? ` · ${item.orgName}` : ""}
                      {item.caseKind ? ` · ${item.caseKind.replace(/_/g, " ")}` : ""}
                      {cid ? ` · ${t("notifications:caseSuffix", { id: cid })}` : ""}
                    </Text>
                  </View>
                  <Feather name="chevron-right" size={18} color={Colors.muted} />
                </TouchableOpacity>
              );
            })}
            {loadingMore ? (
              <LoadingSpinner
                color={GOLD}
                style={{ marginTop: 16 }}
                testID="notifications-load-more-indicator"
              />
            ) : null}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 20, fontWeight: "700", color: Colors.text },
  subtitle: { color: Colors.muted, fontSize: 12, marginTop: 2 },
  unreadBadge: { backgroundColor: "#3b82f622", borderWidth: 1, borderColor: "#3b82f655", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  unreadBadgeText: { color: "#93c5fd", fontSize: 11, fontWeight: "600" },
  markAllBtn: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: Colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  markAllBtnDisabled: { opacity: 0.5 },
  markAllText: { color: Colors.text, fontSize: 12, fontWeight: "600" },
  markAllTextDisabled: { color: Colors.muted },
  scroll: { flex: 1 },
  empty: { alignItems: "center", padding: 32, marginTop: 32 },
  emptyTitle: { color: Colors.text, fontSize: 15, fontWeight: "600", marginTop: 12 },
  emptyText: { color: Colors.muted, fontSize: 13, textAlign: "center", marginTop: 6, lineHeight: 18 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12, backgroundColor: Colors.surface, marginHorizontal: 16, marginTop: 8, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: Colors.border },
  rowUnread: { borderColor: "#3b82f655" },
  iconWrap: { width: 32, height: 32, borderRadius: 8, alignItems: "center", justifyContent: "center", marginTop: 2 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowTitle: { color: Colors.text, fontSize: 14, fontWeight: "600", flex: 1 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#60a5fa" },
  tag: { alignSelf: "flex-start", borderRadius: 4, borderWidth: 1, paddingHorizontal: 6, paddingVertical: 2, marginTop: 4 },
  tagText: { fontSize: 10, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5 },
  rowBody: { color: Colors.muted, fontSize: 13, marginTop: 6, lineHeight: 18 },
  rowMeta: { color: Colors.muted, fontSize: 11, marginTop: 6 },
  section: { marginHorizontal: 16, marginTop: 12, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: "#3b82f655", backgroundColor: "#3b82f60d" },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  sectionTitle: { color: Colors.text, fontSize: 14, fontWeight: "700", flex: 1 },
  sectionBadge: { backgroundColor: "#ef444422", borderWidth: 1, borderColor: "#ef444466", borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  sectionBadgeText: { color: "#fca5a5", fontSize: 11, fontWeight: "700" },
  sectionHint: { color: Colors.muted, fontSize: 12, marginTop: 4 },
});
