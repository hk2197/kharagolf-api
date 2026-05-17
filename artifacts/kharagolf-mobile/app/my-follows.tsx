import React, { useCallback, useState } from "react";
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
import { Stack, router, useFocusEffect } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { fetchPortal } from "@/utils/api";
import { FollowButton } from "@/components/FollowButton";
import { useFolloweeIds } from "@/hooks/useFolloweeIds";

interface FollowListItem {
  userId: number;
  username: string;
  displayName: string | null;
  profileImage: string | null;
  followedAt: string;
}

interface FollowListResponse {
  items: FollowListItem[];
  total: number;
  limit: number;
  offset: number;
}

const PAGE_SIZE = 50;

function initialsOf(name: string | null, username: string): string {
  const source = (name ?? username ?? "").trim();
  if (!source) return "?";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function MyFollowsScreen() {
  const { token } = useAuth();
  const [tab, setTab] = useState<"following" | "followers">("following");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [items, setItems] = useState<FollowListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Pre-fetched followees so each row's <FollowButton> hydrates with the
  // correct state on the Followers tab too (mutual follow).
  const { followeeIds, refresh: refreshFolloweeIds } = useFolloweeIds(token);

  const loadPage = useCallback(
    async (which: "following" | "followers", off: number, append: boolean) => {
      if (!token) return;
      const path = which === "following" ? "/follows/list" : "/followers";
      try {
        if (!append) setLoading(true);
        const res = await fetchPortal<FollowListResponse>(
          `${path}?limit=${PAGE_SIZE}&offset=${off}`,
          token,
        );
        setTotal(res.total ?? 0);
        setItems(prev => (append ? [...prev, ...res.items] : res.items));
        setOffset(off);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [token],
  );

  // Re-load when the screen regains focus or the tab switches so unfollow
  // actions taken on a member profile are reflected here without forcing
  // the user to pull-to-refresh.
  useFocusEffect(
    useCallback(() => {
      setItems([]);
      setOffset(0);
      void loadPage(tab, 0, false);
      refreshFolloweeIds();
    }, [tab, loadPage, refreshFolloweeIds]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setItems([]);
    setOffset(0);
    void loadPage(tab, 0, false);
    refreshFolloweeIds();
  }, [tab, loadPage, refreshFolloweeIds]);

  const onEndReached = useCallback(() => {
    if (loading || refreshing) return;
    const nextOffset = offset + PAGE_SIZE;
    if (nextOffset >= total) return;
    void loadPage(tab, nextOffset, true);
  }, [loading, refreshing, offset, total, tab, loadPage]);

  const renderRow = useCallback(
    ({ item }: { item: FollowListItem }) => {
      const name = item.displayName?.trim() || item.username;
      const isFollowing = tab === "following" ? true : followeeIds.includes(item.userId);
      return (
        <View style={styles.row} testID={`row-${item.userId}`}>
          <TouchableOpacity
            style={styles.rowMain}
            onPress={() =>
              router.push({
                pathname: "/member/[userId]",
                params: { userId: String(item.userId), displayName: name, avatar: item.profileImage ?? "" },
              })
            }
            activeOpacity={0.7}
          >
            {item.profileImage ? (
              <Image source={{ uri: item.profileImage }} style={styles.avatar} />
            ) : (
              <View style={[styles.avatar, styles.avatarFallback]}>
                <Text style={styles.avatarText}>{initialsOf(item.displayName, item.username)}</Text>
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={styles.name} numberOfLines={1}>{name}</Text>
              {item.displayName && item.displayName !== item.username ? (
                <Text style={styles.handle} numberOfLines={1}>@{item.username}</Text>
              ) : null}
            </View>
          </TouchableOpacity>
          <FollowButton userId={item.userId} initialFollowing={isFollowing} size="sm" />
        </View>
      );
    },
    [tab, followeeIds],
  );

  if (!token) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <Stack.Screen options={{ title: "My follows" }} />
        <View style={styles.empty}>
          <Feather name="users" size={36} color={Colors.tabIconDefault} />
          <Text style={styles.emptyTitle}>Sign in to manage your follows</Text>
          <Text style={styles.emptyHint}>
            Your following and followers list shows up here once you're signed in.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <Stack.Screen options={{ title: "My follows" }} />

      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tab, tab === "following" && styles.tabActive]}
          onPress={() => setTab("following")}
          testID="tab-following"
        >
          <Text style={[styles.tabText, tab === "following" && styles.tabTextActive]}>
            Following
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, tab === "followers" && styles.tabActive]}
          onPress={() => setTab("followers")}
          testID="tab-followers"
        >
          <Text style={[styles.tabText, tab === "followers" && styles.tabTextActive]}>
            Followers
          </Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.countLine}>
        {total} {total === 1 ? "person" : "people"}
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
            {tab === "following" ? "You aren't following anyone yet" : "No one is following you yet"}
          </Text>
          <Text style={styles.emptyHint}>
            {tab === "following"
              ? "Tap Follow on member rows or player profiles to start building your list."
              : "As other members tap Follow on your profile, they'll show up here."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={item => String(item.userId)}
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
