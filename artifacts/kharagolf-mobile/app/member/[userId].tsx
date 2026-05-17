import React, { useEffect } from "react";
import { View, Text, StyleSheet, Image, ScrollView, TouchableOpacity } from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Stack, useLocalSearchParams, router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { FollowButton } from "@/components/FollowButton";
import { useFolloweeIds } from "@/hooks/useFolloweeIds";
import { useFollowCounts } from "@/hooks/useFollowCounts";
import { usePublicProfileHandle } from "@/hooks/usePublicProfileHandle";

/**
 * Task #1457 — Surface the public profile screen from existing member screens.
 *
 * This screen historically rendered a tiny private member card. With the
 * public profile viewer now living at app/profile/[handle].tsx (Task #1243),
 * every existing in-app navigation to /member/[userId] (leaderboards,
 * leagues members tab, social feed, my-follows, …) needs to land on the
 * richer public viewer when the player has reserved a public handle and
 * opted in via portal privacy. Otherwise we keep the original private view
 * so members without a public profile still have a sensible destination.
 *
 * We resolve the handle here (rather than at every call site) by hitting
 * the small GET /api/public/users/:userId/handle resolver added in the
 * same task. If a handle comes back, we router.replace to /profile/<handle>
 * so the back button skips this redirect-only screen.
 */
export default function MemberProfileScreen() {
  const { userId, displayName, avatar } = useLocalSearchParams<{
    userId: string; displayName?: string; avatar?: string;
  }>();
  const targetId = Number(userId);
  const { token, user } = useAuth();

  // Look up whether this member has a reserved, opted-in public handle.
  // The result is cached per-userId in React Query (see
  // @/hooks/usePublicProfileHandle) with a long staleTime so a second tap
  // on the same player from a busy leaderboard / leagues members tab
  // resolves synchronously from cache — no spinner, no API round-trip.
  // Task #1790.
  const handleQuery = usePublicProfileHandle(targetId);
  const resolving = handleQuery.isPending && handleQuery.fetchStatus !== "idle";
  const resolvedHandle = handleQuery.data ?? null;
  const hasPublicHandle = typeof resolvedHandle === "string" && resolvedHandle.length > 0;

  // Replace so the back button returns to the screen the player tapped
  // from, not this resolver shim. Runs as soon as a handle is known —
  // either from a fresh fetch or, on subsequent navigations, from the
  // React Query cache on the very first render.
  useEffect(() => {
    if (hasPublicHandle && resolvedHandle) {
      router.replace({ pathname: "/profile/[handle]", params: { handle: resolvedHandle } });
    }
  }, [hasPublicHandle, resolvedHandle]);

  // Pre-fetch the viewer's followees once so the FollowButton hydrates as
  // "Following" instead of flashing "Follow" first. Shared with the social
  // feed via @/hooks/useFolloweeIds (Task #1227).
  const { followeeIds, loading } = useFolloweeIds(token);
  const following = followeeIds.includes(targetId);

  // Task #2153 — surface "X followers · Y following" alongside the Follow
  // button so the in-app private member screen has the same social-graph
  // context that the public profile (Task #1738) already shows. The query
  // is gated on a valid token and userId; the hook returns `null`/cached
  // data otherwise so the UI just hides the row instead of showing zeros.
  const followCounts = useFollowCounts(targetId, token);
  const counts = followCounts.data ?? null;

  const isSelf = user?.id === targetId;
  const name = displayName || `User #${targetId}`;
  const initials = name.split(/\s+/).map(s => s[0]).join("").slice(0, 2).toUpperCase() || "?";

  // While we're resolving the handle, or once we know one exists and have
  // already kicked off the redirect, show a centred spinner instead of the
  // private fallback to avoid a flash of the wrong screen.
  if (resolving || hasPublicHandle) {
    return (
      <View style={styles.loadingContainer} testID="member-resolving">
        <Stack.Screen options={{ title: "Member" }} />
        <LoadingSpinner color={Colors.primary} size="large" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      <Stack.Screen options={{ title: "Member" }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Feather name="chevron-left" size={22} color="#fff" />
        </TouchableOpacity>
      </View>
      <View style={styles.profileCard}>
        {avatar ? (
          <Image source={{ uri: String(avatar) }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
        )}
        <Text style={styles.name}>{name}</Text>
        <Text style={styles.subtle}>Member profile</Text>
        {/* Task #2153 — render the same followers / following counts the
            public profile shows (Task #1738). Hide the row entirely until
            the first fetch resolves so we never flash placeholder zeros;
            on a network failure (`counts === null`) the row simply stays
            hidden, matching the FollowButton's best-effort posture. */}
        {counts ? (
          <View style={styles.followStatsRow} testID="member-follow-stats">
            <View style={styles.followStat} testID="member-followers">
              <Text style={styles.followStatNumber}>
                {counts.followerCount.toLocaleString()}
              </Text>
              <Text style={styles.followStatLabel}>
                {counts.followerCount === 1 ? "Follower" : "Followers"}
              </Text>
            </View>
            <View style={styles.followStatDivider} />
            <View style={styles.followStat} testID="member-following">
              <Text style={styles.followStatNumber}>
                {counts.followingCount.toLocaleString()}
              </Text>
              <Text style={styles.followStatLabel}>Following</Text>
            </View>
          </View>
        ) : null}
        {loading ? (
          <LoadingSpinner color={Colors.primary} style={{ marginTop: 16 }} />
        ) : !isSelf && Number.isFinite(targetId) ? (
          <View style={{ marginTop: 16 }}>
            <FollowButton userId={targetId} initialFollowing={following} size="md" />
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  loadingContainer: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: Colors.background },
  header: { flexDirection: "row", padding: 12 },
  backBtn: { padding: 6 },
  profileCard: {
    margin: 16, padding: 24, alignItems: "center",
    backgroundColor: Colors.surface, borderRadius: 16,
    borderWidth: 1, borderColor: Colors.border,
  },
  avatar: { width: 80, height: 80, borderRadius: 40, marginBottom: 12 },
  avatarFallback: { backgroundColor: `${Colors.primary}30`, alignItems: "center", justifyContent: "center" },
  avatarText: { color: Colors.primary, fontSize: 28, fontWeight: "800" },
  name: { color: "#fff", fontSize: 20, fontWeight: "700" },
  subtle: { color: Colors.tabIconDefault, fontSize: 12, marginTop: 4 },
  // Task #2153 — match the layout used on the public profile screen
  // (app/profile/[handle].tsx) so the in-app and public surfaces feel
  // visually consistent. Width is `alignSelf: "stretch"` so the row
  // spans the card; the divider keeps the two stats visually paired.
  followStatsRow: {
    marginTop: 14, flexDirection: "row", alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.04)",
    borderColor: "rgba(255,255,255,0.08)", borderWidth: 1,
    borderRadius: 12, paddingVertical: 10, paddingHorizontal: 18,
    alignSelf: "stretch", justifyContent: "center",
  },
  followStat: { flex: 1, alignItems: "center" },
  followStatNumber: { color: "#fff", fontSize: 18, fontWeight: "800" },
  followStatLabel: {
    color: "#cbd5e1", fontSize: 11, marginTop: 2,
    textTransform: "uppercase", letterSpacing: 0.5,
  },
  followStatDivider: {
    width: StyleSheet.hairlineWidth, height: "60%",
    backgroundColor: "rgba(255,255,255,0.15)",
  },
});
