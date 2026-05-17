/**
 * Task #2152 — Public profile followers / following list (mobile).
 *
 * Reached by tapping the follower or following count on the public
 * profile screen at app/profile/[handle].tsx. Mirrors the website
 * modal at artifacts/kharagolf-website/src/pages/public-profile.tsx,
 * paging through the new `/api/public/p/:handle/followers|following`
 * endpoints. Members who haven't opened a public profile appear as
 * redacted "Private member" rows so the list still conveys the
 * social graph density without leaking private identities.
 *
 * When the viewer is signed in we also surface the existing
 * <FollowButton> next to each non-private row so they can follow /
 * unfollow without leaving this screen.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  FlatList,
  Image,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { fetchPublic } from "@/utils/api";
import { FollowButton } from "@/components/FollowButton";
import { useFolloweeIds } from "@/hooks/useFolloweeIds";

type FollowsTab = "followers" | "following";

interface PublicFollowRow {
  userId: number;
  displayName: string | null;
  profileImage: string | null;
  publicHandle: string | null;
  isPrivate: boolean;
  followedAt: string;
}

interface PublicFollowsResponse {
  items: PublicFollowRow[];
  total: number;
  limit: number;
  offset: number;
}

const PAGE_SIZE = 50;

function initialsOf(displayName: string | null, publicHandle: string | null): string {
  const source = (displayName ?? publicHandle ?? "").trim();
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function PublicProfileFollowsScreen() {
  const params = useLocalSearchParams<{ handle: string; tab?: string }>();
  const handle = (params.handle ?? "").toLowerCase();
  const initialTab: FollowsTab = params.tab === "following" ? "following" : "followers";

  const { token } = useAuth();
  const { followeeIds } = useFolloweeIds(token);
  const followeeSet = useMemo(() => new Set(followeeIds), [followeeIds]);

  const [tab, setTab] = useState<FollowsTab>(initialTab);
  const [items, setItems] = useState<PublicFollowRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  // Distinct from `loading` so the spinner only blocks the initial
  // load while the "Load more" path uses its own gate. Both flags are
  // consulted by `onEndReached` so FlatList's known habit of firing
  // the callback multiple times in a row never produces concurrent
  // requests (which would otherwise duplicate rows and hammer the
  // rate-limited public endpoint).
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (which: FollowsTab, off: number, append: boolean) => {
      if (!handle) return;
      try {
        if (append) setLoadingMore(true); else setLoading(true);
        const res = await fetchPublic<PublicFollowsResponse>(
          `/p/${encodeURIComponent(handle)}/${which}?limit=${PAGE_SIZE}&offset=${off}`,
        );
        setTotal(res.total ?? 0);
        setItems(prev => (append ? [...prev, ...res.items] : res.items));
        setOffset(off + res.items.length);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load list");
      } finally {
        setLoading(false);
        setLoadingMore(false);
        setRefreshing(false);
      }
    },
    [handle],
  );

  // Reload from offset 0 whenever the active tab (or the handle) changes.
  useEffect(() => {
    setItems([]);
    setOffset(0);
    setTotal(0);
    void loadPage(tab, 0, false);
  }, [tab, loadPage]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setItems([]);
    setOffset(0);
    void loadPage(tab, 0, false);
  }, [tab, loadPage]);

  const onEndReached = useCallback(() => {
    // Gate against the initial load, the pull-to-refresh load, AND a
    // previous "load more" still in flight. Without the loadingMore
    // check FlatList's repeated onEndReached fires would each kick
    // off a duplicate request and double-append the same rows.
    if (loading || loadingMore || refreshing) return;
    if (offset >= total) return;
    void loadPage(tab, offset, true);
  }, [loading, loadingMore, refreshing, offset, total, tab, loadPage]);

  const renderRow = useCallback(
    ({ item }: { item: PublicFollowRow }) => {
      if (item.isPrivate) {
        return (
          <View style={styles.row} testID={`follows-row-private-${item.userId}`}>
            <View style={[styles.avatar, styles.avatarFallback]}>
              <Feather name="lock" size={16} color={Colors.tabIconDefault} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name} numberOfLines={1}>Private member</Text>
              <Text style={styles.handle} numberOfLines={1}>
                Hasn't opened a public profile
              </Text>
            </View>
          </View>
        );
      }

      const name = item.displayName ?? item.publicHandle ?? "Golfer";
      return (
        <View style={styles.row} testID={`follows-row-${item.userId}`}>
          <TouchableOpacity
            style={styles.rowMain}
            activeOpacity={0.7}
            onPress={() => {
              if (item.publicHandle) {
                router.push(`/profile/${item.publicHandle}`);
              }
            }}
          >
            {item.profileImage ? (
              <Image source={{ uri: item.profileImage }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback]}>
                <Text style={styles.avatarText}>{initialsOf(item.displayName, item.publicHandle)}</Text>
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={styles.name} numberOfLines={1}>{name}</Text>
              {item.publicHandle ? (
                <Text style={styles.handle} numberOfLines={1}>@{item.publicHandle}</Text>
              ) : null}
            </View>
          </TouchableOpacity>
          {token ? (
            <FollowButton
              userId={item.userId}
              initialFollowing={followeeSet.has(item.userId)}
              size="sm"
            />
          ) : null}
        </View>
      );
    },
    [followeeSet, token],
  );

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <Stack.Screen
        options={{
          title: tab === "followers" ? "Followers" : "Following",
          headerBackTitle: "Profile",
        }}
      />

      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tab, tab === "followers" && styles.tabActive]}
          onPress={() => setTab("followers")}
          testID="follows-tab-followers"
        >
          <Text style={[styles.tabText, tab === "followers" && styles.tabTextActive]}>
            Followers
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, tab === "following" && styles.tabActive]}
          onPress={() => setTab("following")}
          testID="follows-tab-following"
        >
          <Text style={[styles.tabText, tab === "following" && styles.tabTextActive]}>
            Following
          </Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.countLine}>
        {total.toLocaleString()} {total === 1 ? "person" : "people"}
      </Text>

      {loading && items.length === 0 ? (
        <LoadingSpinner color={Colors.primary} style={{ marginTop: 32 }} />
      ) : error ? (
        <View style={styles.empty}>
          <Feather name="alert-circle" size={36} color={Colors.error} />
          <Text style={styles.emptyTitle}>Could not load list</Text>
          <Text style={styles.emptyHint}>{error}</Text>
        </View>
      ) : items.length === 0 ? (
        <View style={styles.empty}>
          <Feather name="users" size={36} color={Colors.tabIconDefault} />
          <Text style={styles.emptyTitle}>
            {tab === "followers" ? "No followers yet" : "Not following anyone yet"}
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item, idx) => `${item.userId}-${idx}`}
          renderItem={renderRow}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.4}
          refreshControl={
            <RefreshControl tintColor={Colors.primary} refreshing={refreshing} onRefresh={onRefresh} />
          }
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={{ paddingBottom: 24 }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  tabs: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    marginHorizontal: 12,
    marginTop: 8,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: { borderBottomColor: Colors.primary },
  tabText: { color: Colors.tabIconDefault, fontWeight: "600", fontSize: 14 },
  tabTextActive: { color: "#fff" },
  countLine: {
    color: Colors.muted,
    fontSize: 12,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  rowMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 },
  avatar: { width: 40, height: 40, borderRadius: 20 },
  avatarFallback: {
    backgroundColor: `${Colors.primary}30`,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: Colors.primary, fontSize: 14, fontWeight: "800" },
  name: { color: "#fff", fontSize: 15, fontWeight: "600" },
  handle: { color: Colors.tabIconDefault, fontSize: 12, marginTop: 2 },
  separator: { height: 1, backgroundColor: Colors.border, marginLeft: 62 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 },
  emptyTitle: { color: "#fff", fontSize: 16, fontWeight: "600", textAlign: "center" },
  emptyHint: { color: Colors.tabIconDefault, fontSize: 13, textAlign: "center" },
});
