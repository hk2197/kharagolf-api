import { Feather } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import {
  fetchPortal,
  fetchPublic,
  postPortal,
  patchPortal,
  deletePortal,
} from "@/utils/api";

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

interface LeaderboardLite {
  tournamentName: string;
  entries: { playerId: number; playerName: string; flight: string | null }[];
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
}

type NotifyKey = keyof Pick<SpectatorFollow,
  "notifyBirdie" | "notifyEagle" | "notifyHio" |
  "notifyRoundStart" | "notifyRoundFinish" | "notifyTeeOff">;

const NOTIFY_OPTIONS: { key: NotifyKey; labelKey: string; icon: string }[] = [
  { key: "notifyTeeOff", labelKey: "follows.notify.teeOff", icon: "🟢" },
  { key: "notifyBirdie", labelKey: "follows.notify.birdie", icon: "🐦" },
  { key: "notifyEagle", labelKey: "follows.notify.eagle", icon: "🦅" },
  { key: "notifyHio", labelKey: "follows.notify.hio", icon: "⛳" },
  { key: "notifyRoundStart", labelKey: "follows.notify.roundStart", icon: "▶️" },
  { key: "notifyRoundFinish", labelKey: "follows.notify.roundFinish", icon: "🏁" },
];

export default function SpectatorFollowsScreen() {
  const { t, i18n } = useTranslation('leaderboard');
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ tournamentId?: string }>();
  const tournamentId = params.tournamentId ? parseInt(params.tournamentId) : null;
  const { token } = useAuth();
  const qc = useQueryClient();
  const [sendingTest, setSendingTest] = useState(false);

  const currentLang = useMemo(() => {
    const code = (i18n.language ?? "en").split("-")[0];
    return SUPPORTED_LANGUAGES.find(l => l.code === code) ?? SUPPORTED_LANGUAGES[0];
  }, [i18n.language]);

  async function sendTestNotification() {
    if (!token || sendingTest) return;
    setSendingTest(true);
    try {
      const res = await fetch(`${process.env.EXPO_PUBLIC_DOMAIN ? `https://${process.env.EXPO_PUBLIC_DOMAIN}` : ""}/api/portal/spectator-test-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ eventType: "birdie" }),
      });
      const json = await res.json().catch(() => ({})) as {
        delivered?: boolean;
        reason?: string;
        language?: string;
        preview?: { title: string; body: string };
        retryAfterSeconds?: number;
        error?: string;
      };
      if (res.status === 429) {
        Alert.alert(
          t('follows.testPush.rateLimitedTitle'),
          t('follows.testPush.rateLimitedBody', { seconds: json.retryAfterSeconds ?? 30 }),
        );
        return;
      }
      if (!res.ok) {
        Alert.alert(t('follows.testPush.failedTitle'), json.error ?? t('follows.testPush.failedBody'));
        return;
      }
      const previewText = json.preview ? `${json.preview.title}\n${json.preview.body}` : "";
      if (json.delivered) {
        Alert.alert(t('follows.testPush.sentTitle'), `${t('follows.testPush.sentBody')}\n\n${previewText}`);
      } else if (json.reason === "no_device_token") {
        Alert.alert(t('follows.testPush.noDeviceTitle'), `${t('follows.testPush.noDeviceBody')}\n\n${previewText}`);
      } else {
        Alert.alert(t('follows.testPush.failedTitle'), `${t('follows.testPush.failedBody')}\n\n${previewText}`);
      }
    } catch {
      Alert.alert(t('follows.testPush.failedTitle'), t('follows.testPush.failedBody'));
    } finally {
      setSendingTest(false);
    }
  }

  const { data: leaderboard } = useQuery({
    queryKey: ["leaderboard-lite", tournamentId],
    queryFn: () => fetchPublic<LeaderboardLite>(`/tournaments/${tournamentId}/leaderboard`),
    enabled: !!tournamentId,
  });

  const { data: paceData } = useQuery({
    queryKey: ["pace-board", tournamentId],
    queryFn: () => fetchPublic<{ groups: PaceGroup[] }>(`/tournaments/${tournamentId}/pace-board`).catch(() => ({ groups: [] })),
    enabled: !!tournamentId,
  });

  const { data: followsData, isLoading } = useQuery({
    queryKey: ["spectator-follows", tournamentId, token],
    queryFn: () => token && tournamentId
      ? fetchPortal<{ follows: SpectatorFollow[] }>(`/spectator-follows?tournamentId=${tournamentId}`, token)
      : Promise.resolve({ follows: [] as SpectatorFollow[] }),
    enabled: !!tournamentId && !!token,
  });

  const follows = followsData?.follows ?? [];
  const followByPlayer = useMemo(() => {
    const m = new Map<number, SpectatorFollow>();
    for (const f of follows) if (f.playerId != null) m.set(f.playerId, f);
    return m;
  }, [follows]);
  const followByGroup = useMemo(() => {
    const m = new Map<number, SpectatorFollow>();
    for (const f of follows) if (f.teeTimeId != null) m.set(f.teeTimeId, f);
    return m;
  }, [follows]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["spectator-follows", tournamentId, token] });
  };

  async function addFollow(playerId: number) {
    if (!token || !tournamentId) return;
    try {
      await postPortal(`/spectator-follows`, token, { tournamentId, playerId });
      invalidate();
    } catch { /* silent */ }
  }

  async function addGroupFollow(teeTimeId: number) {
    if (!token || !tournamentId) return;
    try {
      await postPortal(`/spectator-follows`, token, { tournamentId, teeTimeId });
      invalidate();
    } catch { /* silent */ }
  }

  async function removeFollow(id: number) {
    if (!token) return;
    try {
      await deletePortal(`/spectator-follows/${id}`, token);
      invalidate();
    } catch { /* silent */ }
  }

  async function togglePref(id: number, key: string, value: boolean) {
    if (!token) return;
    // Optimistic update
    qc.setQueryData<{ follows: SpectatorFollow[] }>(
      ["spectator-follows", tournamentId, token],
      (old) => old ? { follows: old.follows.map(f => f.id === id ? { ...f, [key]: value } : f) } : old
    );
    try {
      await patchPortal(`/spectator-follows/${id}`, token, { [key]: value });
    } catch {
      invalidate();
    }
  }

  if (!token) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + 16 }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <ScreenHeader onBack={() => router.back()} title={t('follows.title')} />
        <View style={styles.emptyState}>
          <Feather name="lock" size={42} color={Colors.muted} />
          <Text style={styles.emptyTitle}>{t('follows.signInRequired')}</Text>
          <Text style={styles.emptySub}>{t('follows.signInSubtitle')}</Text>
        </View>
      </View>
    );
  }

  if (!tournamentId) {
    return (
      <View style={[styles.container, { paddingTop: insets.top + 16 }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <ScreenHeader onBack={() => router.back()} title={t('follows.title')} />
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>{t('follows.noTournament')}</Text>
        </View>
      </View>
    );
  }

  const players = leaderboard?.entries ?? [];

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScreenHeader
        onBack={() => router.back()}
        title={t('follows.title')}
        subtitle={leaderboard?.tournamentName ?? undefined}
      />

      {isLoading ? (
        <View style={styles.emptyState}><LoadingSpinner color={Colors.primary} /></View>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Test notification — Task #803 */}
          <View style={styles.testPushCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.testPushTitle}>{t('follows.testPush.title')}</Text>
              <Text style={styles.testPushSub}>
                {t('follows.testPush.subtitle', { language: `${currentLang.flag} ${currentLang.name}` })}
              </Text>
            </View>
            <Pressable
              onPress={sendTestNotification}
              disabled={sendingTest}
              hitSlop={8}
              style={[styles.testPushBtn, sendingTest && { opacity: 0.6 }]}
            >
              {sendingTest ? (
                <LoadingSpinner size="small" color="#000" />
              ) : (
                <>
                  <Feather name="bell" size={12} color="#000" />
                  <Text style={styles.testPushBtnText}>{t('follows.testPush.button')}</Text>
                </>
              )}
            </Pressable>
          </View>

          {/* Following section */}
          <Text style={styles.sectionLabel}>{t('follows.followingCount', { count: follows.length })}</Text>
          {follows.length === 0 ? (
            <View style={styles.hintCard}>
              <Text style={styles.hintText}>
                {t('follows.emptyHint')}
              </Text>
            </View>
          ) : (
            follows.map(f => {
              const isGroup = f.teeTimeId != null;
              const group = isGroup
                ? (paceData?.groups ?? []).find(g => g.teeTimeId === f.teeTimeId)
                : null;
              const player = !isGroup ? players.find(p => p.playerId === f.playerId) : null;
              const teeStr = group
                ? new Date(group.teeTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                : null;
              return (
                <View key={f.id} style={styles.followCard}>
                  <View style={styles.followHeader}>
                    <View style={{ flex: 1 }}>
                      {isGroup ? (
                        <>
                          <View style={styles.groupTitleRow}>
                            <View style={styles.groupBadge}>
                              <Feather name="users" size={10} color="#C9A84C" />
                              <Text style={styles.groupBadgeText}>{t('follows.groupBadge')}</Text>
                            </View>
                            <Text style={styles.followName}>
                              {group
                                ? t('follows.groupMeta', { round: group.round, time: teeStr })
                                : t('follows.teeGroupHash', { id: f.teeTimeId })}
                            </Text>
                          </View>
                          {group ? (
                            <Text style={styles.followFlight} numberOfLines={2}>
                              {group.players.map(p => p.name).join(", ")}
                            </Text>
                          ) : null}
                        </>
                      ) : (
                        <>
                          <Text style={styles.followName}>{player?.playerName ?? t('follows.playerHash', { id: f.playerId })}</Text>
                          {player?.flight ? <Text style={styles.followFlight}>{player.flight}</Text> : null}
                        </>
                      )}
                    </View>
                    <Pressable onPress={() => removeFollow(f.id)} hitSlop={8} style={styles.unfollowBtn}>
                      <Feather name="star" size={14} color="#C9A84C" />
                      <Text style={styles.unfollowText}>{t('follows.unfollow')}</Text>
                    </Pressable>
                  </View>
                  <View style={styles.prefList}>
                    {NOTIFY_OPTIONS.map(opt => (
                      <View key={opt.key} style={styles.prefRow}>
                        <Text style={styles.prefIcon}>{opt.icon}</Text>
                        <Text style={styles.prefLabel}>{t(opt.labelKey)}</Text>
                        <Switch
                          value={f[opt.key]}
                          onValueChange={(v) => togglePref(f.id, opt.key, v)}
                          trackColor={{ false: Colors.border, true: "#C9A84C" }}
                          thumbColor="#fff"
                        />
                      </View>
                    ))}
                  </View>
                </View>
              );
            })
          )}

          {/* Add tee groups */}
          {(() => {
            const upcomingGroups = (paceData?.groups ?? [])
              .filter(g => g.status !== "complete")
              .slice(0, 8);
            if (upcomingGroups.length === 0) return null;
            return (
              <>
                <Text style={[styles.sectionLabel, { marginTop: 16 }]}>{t('follows.followGroupsTitle')}</Text>
                {upcomingGroups.map(g => {
                  const existing = followByGroup.get(g.teeTimeId);
                  const teeStr = new Date(g.teeTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                  return (
                    <View key={g.teeTimeId} style={styles.playerRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.playerName}>{t('follows.groupMeta', { round: g.round, time: teeStr })}</Text>
                        <Text style={styles.playerFlight} numberOfLines={1}>
                          {g.players.map(p => p.name).join(", ")}
                        </Text>
                      </View>
                      {existing ? (
                        <Pressable onPress={() => removeFollow(existing.id)} hitSlop={8} style={styles.followingPill}>
                          <Feather name="check" size={12} color="#C9A84C" />
                          <Text style={styles.followingPillText}>{t('follows.following')}</Text>
                        </Pressable>
                      ) : (
                        <Pressable onPress={() => addGroupFollow(g.teeTimeId)} hitSlop={8} style={styles.followPill}>
                          <Feather name="plus" size={12} color="#000" />
                          <Text style={styles.followPillText}>{t('follows.followGroup')}</Text>
                        </Pressable>
                      )}
                    </View>
                  );
                })}
              </>
            );
          })()}

          {/* Add players */}
          <Text style={[styles.sectionLabel, { marginTop: 16 }]}>{t('follows.addPlayers')}</Text>
          {players.length === 0 ? (
            <View style={styles.hintCard}>
              <Text style={styles.hintText}>{t('follows.noPlayers')}</Text>
            </View>
          ) : (
            <FlatList
              data={players}
              scrollEnabled={false}
              keyExtractor={(item) => String(item.playerId)}
              renderItem={({ item }) => {
                const existing = followByPlayer.get(item.playerId);
                return (
                  <View style={styles.playerRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.playerName}>{item.playerName}</Text>
                      {item.flight ? <Text style={styles.playerFlight}>{item.flight}</Text> : null}
                    </View>
                    {existing ? (
                      <Pressable onPress={() => removeFollow(existing.id)} hitSlop={8} style={styles.followingPill}>
                        <Feather name="check" size={12} color="#C9A84C" />
                        <Text style={styles.followingPillText}>{t('follows.following')}</Text>
                      </Pressable>
                    ) : (
                      <Pressable onPress={() => addFollow(item.playerId)} hitSlop={8} style={styles.followPill}>
                        <Feather name="plus" size={12} color="#000" />
                        <Text style={styles.followPillText}>{t('follows.follow')}</Text>
                      </Pressable>
                    )}
                  </View>
                );
              }}
            />
          )}
        </ScrollView>
      )}
    </View>
  );
}

function ScreenHeader({ onBack, title, subtitle }: { onBack: () => void; title: string; subtitle?: string }) {
  return (
    <View style={styles.header}>
      <Pressable onPress={onBack} hitSlop={10} style={styles.backBtn}>
        <Feather name="chevron-left" size={22} color={Colors.text} />
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text style={styles.headerTitle}>{title}</Text>
        {subtitle ? <Text style={styles.headerSubtitle} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  backBtn: { padding: 6 },
  headerTitle: { fontFamily: "Inter_700Bold", fontSize: 18, color: Colors.text },
  headerSubtitle: { fontFamily: "Inter_400Regular", fontSize: 12, color: Colors.muted, marginTop: 2 },
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 10 },
  emptyTitle: { fontFamily: "Inter_700Bold", fontSize: 18, color: Colors.text },
  emptySub: { fontFamily: "Inter_400Regular", fontSize: 13, color: Colors.textSecondary, textAlign: "center" },
  sectionLabel: {
    fontFamily: "Inter_700Bold", fontSize: 11, color: Colors.muted,
    letterSpacing: 1.2, textTransform: "uppercase",
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6,
  },
  hintCard: {
    marginHorizontal: 16, padding: 14, borderRadius: 12,
    backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border,
  },
  hintText: { fontFamily: "Inter_400Regular", fontSize: 13, color: Colors.textSecondary, lineHeight: 18 },
  followCard: {
    marginHorizontal: 12, marginVertical: 6, padding: 12, borderRadius: 14,
    backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border,
  },
  followHeader: { flexDirection: "row", alignItems: "center", marginBottom: 8 },
  followName: { fontFamily: "Inter_700Bold", fontSize: 15, color: Colors.text },
  followFlight: { fontFamily: "Inter_400Regular", fontSize: 11, color: Colors.muted, marginTop: 2 },
  groupTitleRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  groupBadge: {
    flexDirection: "row", alignItems: "center", gap: 3,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
    borderWidth: 1, borderColor: "#C9A84C66", backgroundColor: "rgba(201,168,76,0.08)",
  },
  groupBadgeText: { fontFamily: "Inter_700Bold", fontSize: 9, color: "#C9A84C", letterSpacing: 0.6, textTransform: "uppercase" },
  unfollowBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
    borderWidth: 1, borderColor: "#C9A84C66", backgroundColor: "rgba(201,168,76,0.08)",
  },
  unfollowText: { fontFamily: "Inter_600SemiBold", fontSize: 11, color: "#C9A84C" },
  prefList: { gap: 4 },
  prefRow: { flexDirection: "row", alignItems: "center", paddingVertical: 4 },
  prefIcon: { fontSize: 16, width: 24 },
  prefLabel: { flex: 1, fontFamily: "Inter_500Medium", fontSize: 13, color: Colors.text },
  playerRow: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: Colors.border + "60",
  },
  playerName: { fontFamily: "Inter_600SemiBold", fontSize: 14, color: Colors.text },
  playerFlight: { fontFamily: "Inter_400Regular", fontSize: 11, color: Colors.muted, marginTop: 2 },
  followPill: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    backgroundColor: "#C9A84C",
  },
  followPillText: { fontFamily: "Inter_700Bold", fontSize: 12, color: "#000" },
  followingPill: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    borderWidth: 1, borderColor: "#C9A84C66", backgroundColor: "rgba(201,168,76,0.1)",
  },
  followingPillText: { fontFamily: "Inter_600SemiBold", fontSize: 12, color: "#C9A84C" },
  testPushCard: {
    flexDirection: "row", alignItems: "center", gap: 12,
    marginHorizontal: 12, marginTop: 12, padding: 12, borderRadius: 14,
    backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border,
  },
  testPushTitle: { fontFamily: "Inter_700Bold", fontSize: 13, color: Colors.text },
  testPushSub: { fontFamily: "Inter_400Regular", fontSize: 11, color: Colors.muted, marginTop: 2 },
  testPushBtn: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999,
    backgroundColor: "#C9A84C", minWidth: 84, justifyContent: "center",
  },
  testPushBtnText: { fontFamily: "Inter_700Bold", fontSize: 12, color: "#000" },
});
