import { Feather, Ionicons } from "@expo/vector-icons";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
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
import { useTranslation } from "react-i18next";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { BASE_URL } from "@/utils/api";

// ─── Types ───────────────────────────────────────────────────────────────────

interface FantasyLeague {
  id: number;
  name: string;
  description?: string;
  status: "setup" | "drafting" | "active" | "completed";
  format: "overall_standings" | "head_to_head";
  draftType: "snake" | "simultaneous";
  rosterSize: number;
  maxTeams?: number;
  inviteCode?: string;
  tournamentId?: number;
  teamCount: number;
}

interface FantasyTeam {
  id: number;
  name: string;
  draftOrder?: number;
  totalFantasyPoints: number;
  position?: number;
  userId?: number;
  displayName?: string;
}

interface DraftPick {
  id: number;
  fantasyTeamId: number;
  playerId: number;
  pickNumber: number;
  playerFirstName: string;
  playerLastName: string;
  playerHandicap?: string;
}

interface AvailablePlayer {
  id: number;
  firstName: string;
  lastName: string;
  handicapIndex?: string;
  flight?: string;
}

interface FantasyLeagueDetail extends FantasyLeague {
  teams: FantasyTeam[];
  picks: DraftPick[];
  standings: Array<{
    fantasyTeamId: number;
    playerId: number;
    fantasyPoints: number;
    playerFirstName: string;
    playerLastName: string;
  }>;
}

const STATUS_COLORS: Record<string, string> = {
  setup: Colors.muted,
  drafting: "#f59e0b",
  active: Colors.primary,
  completed: Colors.secondary,
};

const STATUS_LABELS: Record<string, string> = {
  setup: "Setup",
  drafting: "Drafting",
  active: "Live",
  completed: "Finished",
};

// ─── Fantasy League Card ──────────────────────────────────────────────────────

function FantasyCard({ item, onPress }: { item: FantasyLeague; onPress: () => void }) {
  const { t } = useTranslation("fantasy");
  const color = STATUS_COLORS[item.status] ?? Colors.muted;
  const statusKey = item.status === "setup" ? "statusSetup" : item.status === "drafting" ? "statusDrafting" : item.status === "active" ? "statusLive" : "statusFinished";
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}>
      <View style={[styles.cardAccent, { backgroundColor: color }]} />
      <View style={styles.cardContent}>
        <View style={styles.cardHeader}>
          <View style={[styles.statusBadge, { backgroundColor: color + "20", borderColor: color + "50" }]}>
            <Text style={[styles.statusText, { color }]}>{t(statusKey)}</Text>
          </View>
          <View style={styles.cardBadges}>
            <Text style={styles.formatBadge}>
              {item.format === "head_to_head" ? t("h2h") : t("standings")}
            </Text>
            <Text style={styles.draftBadge}>
              {item.draftType === "snake" ? t("snakeDraft") : t("simulDraft")} {t("draft")}
            </Text>
          </View>
        </View>
        <Text style={styles.cardTitle}>{item.name}</Text>
        {item.description ? (
          <Text style={styles.description} numberOfLines={2}>{item.description}</Text>
        ) : null}
        <View style={styles.metaRow}>
          <View style={styles.metaItem}>
            <Feather name="users" size={12} color={Colors.textSecondary} />
            <Text style={styles.metaText}>{t("teamCount", { n: item.teamCount })}</Text>
          </View>
          <View style={styles.metaItem}>
            <Ionicons name="star-outline" size={12} color={Colors.primary} />
            <Text style={styles.metaText}>{t("perRoster", { n: item.rosterSize })}</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

// ─── Leaderboard Tab ─────────────────────────────────────────────────────────

function Leaderboard({ detail }: { detail: FantasyLeagueDetail }) {
  const { t } = useTranslation("fantasy");
  const standingsByTeam = new Map<number, typeof detail.standings>();
  for (const s of detail.standings) {
    if (!standingsByTeam.has(s.fantasyTeamId)) standingsByTeam.set(s.fantasyTeamId, []);
    standingsByTeam.get(s.fantasyTeamId)!.push(s);
  }

  return (
    <ScrollView style={{ flex: 1 }}>
      {detail.teams
        .sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
        .map((team, idx) => {
          const pos = team.position ?? idx + 1;
          const roster = standingsByTeam.get(team.id) ?? [];
          const posColor = pos === 1 ? "#facc15" : pos === 2 ? "#94a3b8" : pos === 3 ? "#b45309" : Colors.muted;

          return (
            <View key={team.id} style={[styles.leaderRow, pos === 1 && styles.leaderRowGold]}>
              <View style={[styles.posCircle, { backgroundColor: posColor + "20", borderColor: posColor + "50" }]}>
                <Text style={[styles.posText, { color: posColor }]}>{pos}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.teamName}>{team.name}</Text>
                {team.displayName ? (
                  <Text style={styles.teamOwner}>{team.displayName}</Text>
                ) : null}
                <View style={styles.rosterRow}>
                  {roster.slice(0, 4).map(r => (
                    <Text key={r.playerId} style={styles.rosterChip}>
                      {r.playerFirstName[0]}. {r.playerLastName}
                      {r.fantasyPoints !== 0 && (
                        <Text style={{ color: r.fantasyPoints > 0 ? Colors.primary : Colors.error }}>
                          {" "}{r.fantasyPoints > 0 ? "+" : ""}{r.fantasyPoints}
                        </Text>
                      )}
                    </Text>
                  ))}
                </View>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={styles.pts}>{team.totalFantasyPoints}</Text>
                <Text style={styles.ptsLabel}>{t("pts")}</Text>
              </View>
            </View>
          );
        })}
    </ScrollView>
  );
}

// ─── Draft Tab ────────────────────────────────────────────────────────────────

function DraftTab({
  detail, orgId, token, userId, onRefresh,
}: {
  detail: FantasyLeagueDetail; orgId: number; token: string | null; userId?: number; onRefresh: () => void;
}) {
  const { t } = useTranslation("fantasy");
  const [available, setAvailable] = useState<AvailablePlayer[]>([]);
  const [search, setSearch] = useState("");
  const [pickingId, setPickingId] = useState<number | null>(null);

  const loadAvailable = useCallback(async () => {
    if (!token) return;
    const r = await fetch(`${BASE_URL}/api/organizations/${orgId}/fantasy/${detail.id}/available-players`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) setAvailable(await r.json());
  }, [orgId, detail.id, token]);

  useEffect(() => { loadAvailable(); }, [loadAvailable]);

  const numTeams = detail.teams.length;
  const totalPicks = detail.picks.length;
  const maxPicks = detail.rosterSize * numTeams;
  const isDraftComplete = totalPicks >= maxPicks;
  const myTeam = detail.teams.find(t => t.userId === userId);

  let currentTeamId: number | null = null;
  if (!isDraftComplete && detail.status === "drafting" && detail.draftType === "snake") {
    const sortedTeams = [...detail.teams].sort((a, b) => (a.draftOrder ?? 99) - (b.draftOrder ?? 99));
    const draftRound = Math.floor(totalPicks / numTeams);
    const pickInRound = totalPicks % numTeams;
    const isEven = draftRound % 2 === 0;
    const idx = isEven ? pickInRound : (numTeams - 1 - pickInRound);
    currentTeamId = sortedTeams[idx]?.id ?? null;
  }

  const isMyTurn = myTeam?.id === currentTeamId;

  async function handlePick(playerId: number, name: string) {
    Alert.alert(t("draftPlayerTitle"), t("draftPlayerMsg", { name }), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("draftBtn"),
        onPress: async () => {
          setPickingId(playerId);
          try {
            const r = await fetch(`${BASE_URL}/api/organizations/${orgId}/fantasy/${detail.id}/pick`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ playerId }),
            });
            if (!r.ok) {
              const e = await r.json().catch(() => ({})) as { error?: string };
              Alert.alert(t("error"), e.error ?? t("failedPick"));
            } else {
              onRefresh();
              loadAvailable();
            }
          } finally {
            setPickingId(null);
          }
        },
      },
    ]);
  }

  const filtered = available.filter(p =>
    `${p.firstName} ${p.lastName}`.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <ScrollView style={{ flex: 1 }}>
      {/* Status banner */}
      {detail.status === "drafting" && (
        <View style={[styles.banner, isMyTurn ? styles.bannerActive : styles.bannerWait]}>
          <Ionicons
            name={isMyTurn ? "flash" : "time-outline"}
            size={16}
            color={isMyTurn ? Colors.primary : Colors.textSecondary}
          />
          <Text style={[styles.bannerText, { color: isMyTurn ? Colors.primary : Colors.textSecondary }]}>
            {isMyTurn
              ? t("yourTurn")
              : t("waiting", { pick: totalPicks + 1, max: maxPicks, team: detail.teams.find(tm => tm.id === currentTeamId)?.name ?? "" })}
          </Text>
        </View>
      )}

      {/* Recent picks */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t("recentPicks", { total: totalPicks, max: maxPicks })}</Text>
        {detail.picks.slice(-5).reverse().map(pick => (
          <View key={pick.id} style={styles.pickRow}>
            <Text style={styles.pickNum}>#{pick.pickNumber}</Text>
            <Text style={styles.pickTeam}>{detail.teams.find(tm => tm.id === pick.fantasyTeamId)?.name}</Text>
            <Text style={styles.pickPlayer}>{pick.playerFirstName} {pick.playerLastName}</Text>
          </View>
        ))}
      </View>

      {/* Available players */}
      {(isMyTurn || detail.draftType === "simultaneous") && !isDraftComplete && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("availablePlayers")}</Text>
          <TextInput
            style={styles.searchInput}
            placeholder={t("searchPlayers")}
            placeholderTextColor={Colors.textSecondary}
            value={search}
            onChangeText={setSearch}
          />
          {filtered.map(p => (
            <View key={p.id} style={styles.playerRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.playerName}>{p.firstName} {p.lastName}</Text>
                {p.handicapIndex ? (
                  <Text style={styles.playerMeta}>{t("hcp", { hcp: p.handicapIndex })}{p.flight ? ` · ${t("flight", { flight: p.flight })}` : ""}</Text>
                ) : null}
              </View>
              <Pressable
                onPress={() => handlePick(p.id, `${p.firstName} ${p.lastName}`)}
                style={[styles.draftBtn, pickingId === p.id && { opacity: 0.5 }]}
                disabled={pickingId !== null}
              >
                <Text style={styles.draftBtnText}>{t("draftBtn")}</Text>
              </Pressable>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

// ─── Detail Modal ─────────────────────────────────────────────────────────────

type TabKey = "leaderboard" | "draft";

function FantasyDetailView({
  league, orgId, token, userId, onBack,
}: {
  league: FantasyLeague; orgId: number; token: string | null; userId?: number; onBack: () => void;
}) {
  const { t } = useTranslation("fantasy");
  const [tab, setTab] = useState<TabKey>("leaderboard");
  const [detail, setDetail] = useState<FantasyLeagueDetail | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch(`${BASE_URL}/api/organizations/${orgId}/fantasy/${league.id}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (r.ok) setDetail(await r.json());
    } finally {
      setRefreshing(false);
    }
  }, [orgId, league.id, token]);

  useEffect(() => { load(); }, [load]);

  // Poll for live leaderboard updates when the league is active
  useEffect(() => {
    if (!token || !league.id) return;
    if (league.status !== "active" && league.status !== "drafting") return;

    // Refresh every 30 seconds while the league is live
    pollRef.current = setInterval(() => {
      load();
    }, 30000);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [league.id, league.status, token, load]);

  const color = STATUS_COLORS[league.status] ?? Colors.muted;
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.detailContainer, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.detailHeader}>
        <Pressable onPress={onBack} style={styles.backBtn}>
          <Feather name="arrow-left" size={20} color={Colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.detailTitle} numberOfLines={1}>{league.name}</Text>
          <View style={[styles.statusBadge, { backgroundColor: color + "20", borderColor: color + "50", alignSelf: "flex-start" }]}>
            <Text style={[styles.statusText, { color }]}>
              {league.status === "setup" ? t("statusSetup") : league.status === "drafting" ? t("statusDrafting") : league.status === "active" ? t("statusLive") : t("statusFinished")}
            </Text>
          </View>
        </View>
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        {(["leaderboard", "draft"] as TabKey[]).map(tabKey => (
          <Pressable key={tabKey} onPress={() => setTab(tabKey)} style={[styles.tab, tab === tabKey && styles.tabActive]}>
            <Text style={[styles.tabText, tab === tabKey && styles.tabTextActive]}>
              {tabKey === "leaderboard" ? t("tabLeaderboard") : t("tabDraft")}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Content */}
      {!detail ? (
        <LoadingSpinner size="large" color={Colors.primary} style={{ marginTop: 40 }} />
      ) : tab === "leaderboard" ? (
        <Leaderboard detail={detail} />
      ) : (
        <DraftTab detail={detail} orgId={orgId} token={token} userId={userId} onRefresh={load} />
      )}
    </View>
  );
}

// ─── Main Tab ─────────────────────────────────────────────────────────────────

export default function FantasyTab() {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation("fantasy");
  const { token, user } = useAuth();
  const orgId = user?.organizationId;
  const userId = user?.id;

  const [leagues, setLeagues] = useState<FantasyLeague[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedLeague, setSelectedLeague] = useState<FantasyLeague | null>(null);

  const loadLeagues = useCallback(async () => {
    if (!orgId) return;
    try {
      const r = await fetch(`${BASE_URL}/api/organizations/${orgId}/fantasy`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (r.ok) setLeagues(await r.json());
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [orgId, token]);

  useEffect(() => { loadLeagues(); }, [loadLeagues]);

  if (selectedLeague && orgId) {
    return (
      <FantasyDetailView
        league={selectedLeague}
        orgId={orgId}
        token={token}
        userId={userId}
        onBack={() => setSelectedLeague(null)}
      />
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Ionicons name="trophy" size={28} color={Colors.primary} />
        <Text style={styles.headerTitle}>{t("title")}</Text>
      </View>
      <Text style={styles.headerSub}>{t("subtitle")}</Text>

      {loading ? (
        <LoadingSpinner size="large" color={Colors.primary} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={leagues}
          keyExtractor={l => String(l.id)}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); loadLeagues(); }}
              tintColor={Colors.primary}
            />
          }
          contentContainerStyle={{ paddingBottom: insets.bottom + 80, paddingTop: 12 }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="trophy-outline" size={52} color={Colors.muted} />
              <Text style={styles.emptyTitle}>{t("noLeagues")}</Text>
              <Text style={styles.emptyText}>{t("noLeaguesSub")}</Text>
            </View>
          }
          renderItem={({ item }) => (
            <FantasyCard item={item} onPress={() => setSelectedLeague(item)} />
          )}
        />
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4,
  },
  headerTitle: { fontSize: 24, fontWeight: "700", color: Colors.text },
  headerSub: {
    fontSize: 13, color: Colors.textSecondary,
    paddingHorizontal: 16, marginBottom: 4,
  },

  card: {
    backgroundColor: Colors.surface, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border,
    flexDirection: "row", marginHorizontal: 16, marginVertical: 6,
    overflow: "hidden",
  },
  cardAccent: { width: 4 },
  cardContent: { flex: 1, padding: 14 },
  cardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  cardBadges: { flexDirection: "row", gap: 4 },
  cardTitle: { fontSize: 16, fontWeight: "700", color: Colors.text, marginBottom: 4 },
  description: { fontSize: 13, color: Colors.textSecondary, marginBottom: 8 },
  metaRow: { flexDirection: "row", gap: 12 },
  metaItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { fontSize: 12, color: Colors.textSecondary },

  statusBadge: {
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 6, borderWidth: 1,
  },
  statusText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.5 },
  formatBadge: {
    fontSize: 10, color: Colors.textSecondary,
    backgroundColor: Colors.surface, borderRadius: 4,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  draftBadge: {
    fontSize: 10, color: Colors.textSecondary,
    backgroundColor: Colors.surface, borderRadius: 4,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: 6, paddingVertical: 2,
  },

  empty: { alignItems: "center", paddingTop: 60, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 18, fontWeight: "600", color: Colors.textSecondary, marginTop: 16 },
  emptyText: { fontSize: 14, color: Colors.muted, textAlign: "center", marginTop: 8, lineHeight: 20 },

  // Detail
  detailContainer: { flex: 1, backgroundColor: Colors.background },
  detailHeader: {
    flexDirection: "row", alignItems: "flex-start", gap: 12,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  backBtn: { padding: 4, marginTop: 2 },
  detailTitle: { fontSize: 18, fontWeight: "700", color: Colors.text, marginBottom: 4 },

  tabs: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: Colors.border },
  tab: { flex: 1, paddingVertical: 12, alignItems: "center" },
  tabActive: { borderBottomWidth: 2, borderBottomColor: Colors.primary },
  tabText: { fontSize: 14, fontWeight: "500", color: Colors.textSecondary },
  tabTextActive: { color: Colors.primary },

  // Leaderboard
  leaderRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    padding: 14, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  leaderRowGold: { backgroundColor: "#facc1508" },
  posCircle: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: "center", justifyContent: "center",
    borderWidth: 1,
  },
  posText: { fontSize: 15, fontWeight: "700" },
  teamName: { fontSize: 15, fontWeight: "600", color: Colors.text },
  teamOwner: { fontSize: 12, color: Colors.textSecondary },
  rosterRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 4 },
  rosterChip: { fontSize: 11, color: Colors.textSecondary },
  pts: { fontSize: 22, fontWeight: "700", color: Colors.primary },
  ptsLabel: { fontSize: 11, color: Colors.textSecondary },

  // Banner
  banner: {
    flexDirection: "row", alignItems: "center", gap: 8,
    padding: 12, marginHorizontal: 16, marginVertical: 8,
    borderRadius: 10, borderWidth: 1,
  },
  bannerActive: { backgroundColor: Colors.primary + "15", borderColor: Colors.primary + "50" },
  bannerWait: { backgroundColor: Colors.surface, borderColor: Colors.border },
  bannerText: { fontSize: 14, fontWeight: "500", flex: 1 },

  // Section
  section: { padding: 16 },
  sectionTitle: { fontSize: 14, fontWeight: "600", color: Colors.textSecondary, marginBottom: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  searchInput: {
    backgroundColor: Colors.surface, borderRadius: 8,
    borderWidth: 1, borderColor: Colors.border,
    color: Colors.text, padding: 10, marginBottom: 10, fontSize: 14,
  },

  // Pick list
  pickRow: { flexDirection: "row", gap: 8, paddingVertical: 4 },
  pickNum: { width: 28, fontSize: 12, color: Colors.primary, fontWeight: "600" },
  pickTeam: { flex: 1, fontSize: 12, color: Colors.textSecondary },
  pickPlayer: { flex: 1.5, fontSize: 12, color: Colors.text },

  // Player list
  playerRow: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  playerName: { fontSize: 14, fontWeight: "500", color: Colors.text },
  playerMeta: { fontSize: 12, color: Colors.textSecondary },
  draftBtn: {
    backgroundColor: Colors.primary, paddingHorizontal: 14, paddingVertical: 6,
    borderRadius: 8,
  },
  draftBtnText: { fontSize: 13, fontWeight: "600", color: "#fff" },
});
