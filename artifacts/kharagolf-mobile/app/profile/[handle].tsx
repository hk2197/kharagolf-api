/**
 * Task #1243 — Public profile viewer for the KHARAGOLF mobile app.
 *
 * The website renders the same profile at kharagolf.com/p/<handle> via
 * artifacts/kharagolf-website/src/pages/public-profile.tsx, and Task #1083
 * wired its share buttons to POST /api/public/p/:handle/share-events.
 * The mobile app advertises a `kharagolf://profile/<handle>` deep link
 * (see public.ts route GET /api/public/p/:handle deepLinks.mobile) but
 * had no in-app screen to satisfy that deep link or fire share events.
 *
 * This screen:
 *   - Fetches the public profile via GET /api/public/p/:handle.
 *   - Renders a minimal viewer (avatar, name, bio, location, handicap,
 *     home club, recent rounds, achievements teaser) so visitors who land
 *     here from a tap on the deep link, a notification, or a QR scan see
 *     something useful instead of a 404.
 *   - Exposes Copy / Native share / QR share actions that POST to
 *     /api/public/p/:handle/share-events with `source: "mobile"` so the
 *     "Shared N times" social-proof badge counts native mobile share
 *     traffic from visitors as well as web visitors.
 *   - Refreshes the share-stats badge after each share so the count moves
 *     immediately.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Feather } from "@expo/vector-icons";

const BASE_URL = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : "";

const PUBLIC_PROFILE_BASE = "https://kharagolf.com";

type ShareMethod = "copy" | "native_share" | "qr_open";

interface ProfileResponse {
  handle: string;
  displayName: string;
  profileImage: string | null;
  bio: string | null;
  location: string | null;
  homeClub: { name: string; slug: string } | null;
  memberSince: string;
  privacy: {
    showHandicap: boolean;
    showRecentRounds: boolean;
    showAchievements: boolean;
    showFavoriteCourses: boolean;
  };
  currentHandicap: number | null;
  recentRounds: Array<{
    shareToken: string;
    tournamentName: string;
    courseName: string | null;
    startDate: string | null;
    gross: number;
    toPar: number | null;
  }>;
  achievements: Array<{
    badgeType: string;
    badgeLabel: string;
    badgeIcon: string;
  }>;
  favoriteCourses: Array<{ courseId: number; name: string; rounds: number }>;
  // Task #1738 — social-graph counts shown on the profile hero so visitors
  // can see how popular this player is at a glance. Optional for
  // back-compat with older API builds — read with `?? 0`.
  followerCount?: number;
  followingCount?: number;
}

function fmtToPar(toPar: number | null): string {
  if (toPar === null) return "";
  if (toPar === 0) return "E";
  return toPar > 0 ? `+${toPar}` : String(toPar);
}

export default function PublicProfileScreen() {
  const { handle: rawHandle } = useLocalSearchParams<{ handle: string }>();
  const handle = (rawHandle ?? "").toString().toLowerCase();

  const [data, setData] = useState<ProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"not-found" | "error" | null>(null);
  const [shareCount, setShareCount] = useState<number | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const profileUrl = useMemo(
    () => (handle ? `${PUBLIC_PROFILE_BASE}/p/${handle}` : ""),
    [handle],
  );

  useEffect(() => {
    if (!handle) { setError("not-found"); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`${BASE_URL}/api/public/p/${encodeURIComponent(handle)}`)
      .then(async r => {
        if (cancelled) return null;
        if (r.status === 404) { setError("not-found"); return null; }
        if (!r.ok) { setError("error"); return null; }
        return r.json() as Promise<ProfileResponse>;
      })
      .then(j => { if (!cancelled && j) setData(j); })
      .catch(() => { if (!cancelled) setError("error"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [handle]);

  const refetchShareCount = useCallback(() => {
    if (!handle) return;
    fetch(`${BASE_URL}/api/public/p/${encodeURIComponent(handle)}/share-stats`)
      .then(r => r.ok ? r.json() : null)
      .then((j: { total: number } | null) => {
        if (j && typeof j.total === "number") setShareCount(j.total);
      })
      .catch(() => { /* social-proof is non-essential */ });
  }, [handle]);

  useEffect(() => {
    if (!handle) return;
    refetchShareCount();
  }, [handle, refetchShareCount]);

  const trackShare = useCallback((method: ShareMethod) => {
    if (!handle) return;
    // Optimistic bump — the badge updates instantly and reconciles with
    // the server below.
    setShareCount(prev => (prev === null ? prev : prev + 1));
    fetch(`${BASE_URL}/api/public/p/${encodeURIComponent(handle)}/share-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, source: "mobile" }),
    })
      .then(() => refetchShareCount())
      .catch(() => { /* analytics only */ });
  }, [handle, refetchShareCount]);

  async function copyLink() {
    if (!profileUrl) return;
    try {
      await Clipboard.setStringAsync(profileUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      trackShare("copy");
    } catch {
      Alert.alert("Copy failed", "Could not copy the profile link.");
    }
  }

  async function nativeShare() {
    if (!profileUrl || !data) return;
    try {
      const result = await Share.share({
        title: `${data.displayName} (@${data.handle}) on KHARAGOLF`,
        message: `Check out ${data.displayName}'s golf profile on KHARAGOLF: ${profileUrl}`,
        url: profileUrl,
      });
      if (result.action === Share.sharedAction) {
        trackShare("native_share");
      }
    } catch {
      Alert.alert("Share failed", "Could not open the share sheet.");
    }
  }

  function openQr() {
    setQrOpen(true);
    trackShare("qr_open");
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <Stack.Screen options={{ headerShown: false }} />
        <LoadingSpinner color="#10b981" size="large" />
      </SafeAreaView>
    );
  }

  if (error === "not-found" || !data) {
    return (
      <SafeAreaView style={styles.center}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={styles.errorTitle}>Profile not found</Text>
        <Text style={styles.muted}>
          This player either hasn&apos;t published a public profile, or the handle is incorrect.
        </Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.primaryBtn}>
          <Text style={styles.primaryBtnText}>Go back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const initials = data.displayName.split(/\s+/).map(s => s[0]).join("").slice(0, 2).toUpperCase() || "?";

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#0a1a0f" }} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} testID="back-btn">
          <Feather name="chevron-left" size={26} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>@{data.handle}</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 60 }}>
        <View style={styles.heroCard}>
          {data.profileImage ? (
            <Image source={{ uri: data.profileImage }} style={styles.avatar} testID="profile-avatar" />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <Text style={styles.avatarText}>{initials}</Text>
            </View>
          )}
          <Text style={styles.displayName} testID="profile-name">{data.displayName}</Text>
          <Text style={styles.handle}>@{data.handle}</Text>
          {data.bio ? <Text style={styles.bio}>{data.bio}</Text> : null}
          <View style={styles.metaRow}>
            {data.location ? (
              <View style={styles.metaChip}>
                <Feather name="map-pin" size={12} color="#9ca3af" />
                <Text style={styles.metaChipText}>{data.location}</Text>
              </View>
            ) : null}
            {data.homeClub ? (
              <View style={styles.metaChip}>
                <Feather name="award" size={12} color="#9ca3af" />
                <Text style={styles.metaChipText}>{data.homeClub.name}</Text>
              </View>
            ) : null}
            <View style={styles.metaChip}>
              <Feather name="calendar" size={12} color="#9ca3af" />
              <Text style={styles.metaChipText}>
                Member since {new Date(data.memberSince).getFullYear()}
              </Text>
            </View>
          </View>
          {/* Task #1738 — followers / following counts so visitors can see
              how popular this player is at a glance.
              Task #2152 — counts are now tappable and route to a paginated
              list view (`profile/<handle>/follows?tab=...`). Privacy is
              honoured server-side: members who haven't opened a public
              profile appear as "Private member" rows in the list. */}
          <View style={styles.followStatsRow} testID="profile-follow-stats">
            <TouchableOpacity
              style={styles.followStat}
              testID="profile-followers"
              accessibilityRole="button"
              accessibilityLabel={`View followers (${(data.followerCount ?? 0).toLocaleString()})`}
              onPress={() => router.push(`/profile/${data.handle}/follows?tab=followers`)}
            >
              <Text style={styles.followStatNumber}>
                {(data.followerCount ?? 0).toLocaleString()}
              </Text>
              <Text style={styles.followStatLabel}>
                {(data.followerCount ?? 0) === 1 ? "Follower" : "Followers"}
              </Text>
            </TouchableOpacity>
            <View style={styles.followStatDivider} />
            <TouchableOpacity
              style={styles.followStat}
              testID="profile-following"
              accessibilityRole="button"
              accessibilityLabel={`View who ${data.displayName} follows (${(data.followingCount ?? 0).toLocaleString()})`}
              onPress={() => router.push(`/profile/${data.handle}/follows?tab=following`)}
            >
              <Text style={styles.followStatNumber}>
                {(data.followingCount ?? 0).toLocaleString()}
              </Text>
              <Text style={styles.followStatLabel}>Following</Text>
            </TouchableOpacity>
          </View>
          {data.privacy.showHandicap && data.currentHandicap !== null ? (
            <View style={styles.handicapBadge}>
              <Text style={styles.handicapLabel}>Handicap Index</Text>
              <Text style={styles.handicapValue} testID="profile-handicap">
                {data.currentHandicap.toFixed(1)}
              </Text>
            </View>
          ) : null}
        </View>

        <View style={styles.shareCard} testID="share-card">
          <View style={styles.shareHeaderRow}>
            <Text style={styles.shareLead}>Share this profile</Text>
            {shareCount !== null && shareCount >= 3 ? (
              <View style={styles.shareCountPill} testID="share-count-badge">
                <Feather name="trending-up" size={11} color="#34d399" />
                <Text style={styles.shareCountText}>
                  {shareCount === 1 ? "Shared 1 time" : `Shared ${shareCount} times`}
                </Text>
              </View>
            ) : null}
          </View>
          <View style={styles.shareRow}>
            <TouchableOpacity onPress={copyLink} style={[styles.primaryBtn, styles.shareBtn]} testID="share-copy">
              <Feather name={copied ? "check" : "copy"} size={14} color="#fff" />
              <Text style={[styles.primaryBtnText, { marginLeft: 6 }]}>
                {copied ? "Copied!" : "Copy link"}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={nativeShare} style={[styles.secondaryBtn, styles.shareBtn]} testID="share-native">
              <Feather name="share-2" size={14} color="#10b981" />
              <Text style={[styles.secondaryBtnText, { marginLeft: 6 }]}>Share…</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={openQr} style={[styles.secondaryBtn, styles.shareBtn]} testID="share-qr">
              <Feather name="grid" size={14} color="#10b981" />
              <Text style={[styles.secondaryBtnText, { marginLeft: 6 }]}>QR</Text>
            </TouchableOpacity>
          </View>
        </View>

        {data.privacy.showRecentRounds && data.recentRounds.length > 0 ? (
          <View style={styles.section} testID="section-rounds">
            <Text style={styles.sectionTitle}>Recent rounds</Text>
            {data.recentRounds.slice(0, 5).map(r => (
              <View key={r.shareToken} style={styles.roundRow} testID={`round-${r.shareToken}`}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={styles.roundTitle} numberOfLines={1}>{r.tournamentName}</Text>
                  <Text style={styles.muted} numberOfLines={1}>
                    {(r.courseName ?? "Course")}
                    {r.startDate ? ` · ${new Date(r.startDate).toLocaleDateString()}` : ""}
                  </Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={styles.roundScore}>{r.gross}</Text>
                  {r.toPar !== null ? (
                    <Text
                      style={[
                        styles.roundToPar,
                        r.toPar < 0 ? { color: "#34d399" } : r.toPar > 0 ? { color: "#fbbf24" } : { color: "#9ca3af" },
                      ]}
                    >
                      {fmtToPar(r.toPar)}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {data.privacy.showAchievements && data.achievements.length > 0 ? (
          <View style={styles.section} testID="section-achievements">
            <Text style={styles.sectionTitle}>Recent achievements</Text>
            <View style={styles.badgeWrap}>
              {data.achievements.slice(0, 8).map(b => (
                <View key={b.badgeType} style={styles.badgeChip} testID={`badge-${b.badgeType}`}>
                  <Text style={styles.badgeIcon}>{b.badgeIcon}</Text>
                  <Text style={styles.badgeLabel} numberOfLines={1}>{b.badgeLabel}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {data.privacy.showFavoriteCourses && data.favoriteCourses.length > 0 ? (
          <View style={styles.section} testID="section-favourites">
            <Text style={styles.sectionTitle}>Favourite courses</Text>
            {data.favoriteCourses.map(c => (
              <View key={c.courseId} style={styles.favRow}>
                <Text style={styles.favName} numberOfLines={1}>{c.name}</Text>
                <Text style={styles.muted}>
                  {c.rounds} round{c.rounds === 1 ? "" : "s"}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {!data.privacy.showHandicap && !data.privacy.showRecentRounds &&
          !data.privacy.showAchievements && !data.privacy.showFavoriteCourses ? (
          <View style={styles.section}>
            <Text style={styles.muted}>
              This player has chosen not to share any public stats yet.
            </Text>
          </View>
        ) : null}
      </ScrollView>

      <Modal visible={qrOpen} transparent animationType="fade" onRequestClose={() => setQrOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setQrOpen(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()} testID="qr-modal">
            <Text style={styles.modalTitle}>Scan to view profile</Text>
            <Text style={[styles.muted, { textAlign: "center", marginBottom: 14 }]}>
              @{data.handle}
            </Text>
            <View style={styles.qrWrap}>
              <QRCode value={profileUrl} size={220} backgroundColor="#fff" color="#0a1a0f" />
            </View>
            <Text style={styles.qrUrl}>{profileUrl}</Text>
            <TouchableOpacity onPress={() => setQrOpen(false)} style={[styles.primaryBtn, { marginTop: 16 }]} testID="qr-close">
              <Text style={styles.primaryBtnText}>Close</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1, alignItems: "center", justifyContent: "center",
    backgroundColor: "#0a1a0f", padding: 24,
  },
  errorTitle: { color: "#fff", fontSize: 20, fontWeight: "700", marginBottom: 8 },
  muted: { color: "#9ca3af", fontSize: 12, lineHeight: 16 },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.08)",
  },
  headerTitle: { color: "#fff", fontSize: 17, fontWeight: "600", flex: 1, textAlign: "center" },
  heroCard: {
    backgroundColor: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.08)",
    borderWidth: 1, borderRadius: 16, padding: 18, alignItems: "center", marginBottom: 14,
  },
  avatar: { width: 96, height: 96, borderRadius: 48, marginBottom: 12 },
  avatarFallback: { backgroundColor: "rgba(16,185,129,0.2)", alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#10b981", fontSize: 32, fontWeight: "800" },
  displayName: { color: "#fff", fontSize: 22, fontWeight: "700" },
  handle: { color: "#34d399", fontSize: 13, marginTop: 2 },
  bio: { color: "#d1d5db", fontSize: 14, marginTop: 10, textAlign: "center" },
  metaRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 12, justifyContent: "center" },
  metaChip: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999,
  },
  metaChipText: { color: "#cbd5e1", fontSize: 11 },
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
  handicapBadge: {
    marginTop: 14, backgroundColor: "rgba(16,185,129,0.12)",
    borderColor: "rgba(16,185,129,0.3)", borderWidth: 1,
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10, alignItems: "center",
  },
  handicapLabel: { color: "#a7f3d0", fontSize: 10, textTransform: "uppercase", letterSpacing: 1 },
  handicapValue: { color: "#fff", fontSize: 24, fontWeight: "800", marginTop: 2 },
  shareCard: {
    backgroundColor: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.08)",
    borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 14,
  },
  shareHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 6 },
  shareLead: { color: "#fff", fontSize: 14, fontWeight: "600" },
  shareCountPill: {
    flexDirection: "row", alignItems: "center", gap: 4,
    backgroundColor: "rgba(16,185,129,0.12)", borderColor: "rgba(16,185,129,0.3)",
    borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
  },
  shareCountText: { color: "#a7f3d0", fontSize: 11, fontWeight: "600" },
  shareRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  shareBtn: { flex: 1, minWidth: 100, marginTop: 0 },
  primaryBtn: {
    backgroundColor: "#10b981", paddingVertical: 11, paddingHorizontal: 14,
    borderRadius: 8, alignItems: "center", justifyContent: "center",
    flexDirection: "row", marginTop: 8,
  },
  primaryBtnText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  secondaryBtn: {
    borderWidth: 1, borderColor: "#10b981", paddingVertical: 11, paddingHorizontal: 14,
    borderRadius: 8, alignItems: "center", justifyContent: "center",
    flexDirection: "row", marginTop: 8,
  },
  secondaryBtnText: { color: "#10b981", fontWeight: "600", fontSize: 14 },
  section: {
    backgroundColor: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.08)",
    borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 14,
  },
  sectionTitle: { color: "#fff", fontSize: 15, fontWeight: "700", marginBottom: 10 },
  roundRow: {
    flexDirection: "row", alignItems: "center", paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "rgba(255,255,255,0.08)",
  },
  roundTitle: { color: "#fff", fontSize: 14, fontWeight: "600", marginBottom: 2 },
  roundScore: { color: "#fff", fontSize: 20, fontWeight: "800", lineHeight: 22 },
  roundToPar: { fontSize: 11, fontWeight: "700", marginTop: 2 },
  badgeWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  badgeChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    maxWidth: "100%",
  },
  badgeIcon: { fontSize: 14 },
  badgeLabel: { color: "#fff", fontSize: 12, fontWeight: "500" },
  favRow: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "rgba(255,255,255,0.08)",
  },
  favName: { color: "#fff", fontSize: 14, flex: 1, paddingRight: 8 },
  modalBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.7)",
    alignItems: "center", justifyContent: "center", padding: 24,
  },
  modalCard: {
    backgroundColor: "#0f2418", borderColor: "rgba(255,255,255,0.12)", borderWidth: 1,
    borderRadius: 16, padding: 20, width: "100%", maxWidth: 340, alignItems: "stretch",
  },
  modalTitle: { color: "#fff", fontSize: 17, fontWeight: "600", textAlign: "center", marginBottom: 4 },
  qrWrap: {
    backgroundColor: "#fff", padding: 16, borderRadius: 12,
    alignItems: "center", justifyContent: "center",
  },
  qrUrl: { color: "#34d399", fontSize: 12, marginTop: 12, textAlign: "center" },
});
