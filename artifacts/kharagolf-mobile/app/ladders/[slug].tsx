/**
 * Player-facing ladder detail + registration screen (Task #463).
 *
 * Loads a public cross-club ladder by share slug, lets a signed-in player
 * register via POST /api/cross-club-ladders/:id/register, and highlights
 * the player's own row in the standings.
 */
import React, { useCallback, useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Stack, useLocalSearchParams, router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { BASE_URL } from "@/utils/api";
import { useAuth } from "@/context/auth";

interface LadderClub {
  organizationId: number;
  orgName: string | null;
  orgSlug: string | null;
}
interface StandingRow {
  id: number;
  playerName: string;
  homeOrganizationId: number | null;
  division: number;
  totalPoints: number;
  roundsCounted: number;
  position: number | null;
  previousPosition: number | null;
  orgName: string | null;
  orgSlug: string | null;
}
interface MyResultRow {
  id: number;
  roundDate: string;
  organizationId: number | null;
  orgName: string | null;
  orgSlug: string | null;
  grossScore: number | null;
  netScore: number | null;
  stablefordPoints: number | null;
  pointsAwarded: number;
  countedTowardTotal: boolean;
  generalPlayRoundId: number | null;
  tournamentId: number | null;
  notes: string | null;
}
interface MyResultsPayload {
  entry: { id: number; division: number; totalPoints: number; roundsCounted: number; position: number | null } | null;
  results: MyResultRow[];
}
interface LadderDetail {
  id: number;
  name: string;
  description: string | null;
  scope: "regional" | "national";
  format: string;
  status: string;
  region: string | null;
  shareSlug: string;
  seasonStart: string;
  seasonEnd: string;
  minHandicap: string | null;
  maxHandicap: string | null;
  bestOfRounds: number | null;
  divisionCount: number;
  clubs: LadderClub[];
  standings: StandingRow[];
}

const FORMAT_LABEL: Record<string, string> = {
  stableford: "Stableford",
  stroke: "Stroke",
  team_series: "Team Series",
  knockout_cup: "Knockout Cup",
  national_ladder: "Ladder",
};

function formatDateRange(start: string, end: string): string {
  try {
    const s = new Date(start).toLocaleDateString(undefined, { month: "short", year: "numeric" });
    const e = new Date(end).toLocaleDateString(undefined, { month: "short", year: "numeric" });
    return `${s} – ${e}`;
  } catch {
    return "";
  }
}

export default function LadderDetailScreen() {
  const insets = useSafeAreaInsets();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { token, user, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [registering, setRegistering] = useState(false);

  const { data, isLoading, error, refetch } = useQuery<LadderDetail>({
    queryKey: ["public-ladder", slug],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/public/cross-club-ladders/${slug}`);
      if (!res.ok) throw new Error(`Failed to load ladder (${res.status})`);
      return res.json() as Promise<LadderDetail>;
    },
    enabled: !!slug,
  });

  // The public payload doesn't expose userId, so we identify the player's
  // own row via the entry returned by the registration call (kept in local
  // state) and, as a fallback, any standing whose playerName matches the
  // signed-in user's display name.
  const [myEntryId, setMyEntryId] = useState<number | null>(null);

  // Player's qualifying-round history (signed-in only). Returns the player's
  // entry (if registered) plus every result row posted against it.
  const { data: myResults, refetch: refetchMyResults, isFetching: isFetchingResults } = useQuery<MyResultsPayload>({
    queryKey: ["public-ladder", slug, "my-results", data?.id ?? null, token ?? null],
    enabled: !!data && !!token,
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/cross-club-ladders/${data!.id}/my-results`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "x-client-type": "mobile",
        },
      });
      if (!res.ok) throw new Error(`Failed to load history (${res.status})`);
      return res.json() as Promise<MyResultsPayload>;
    },
  });

  const myStanding = useMemo(() => {
    if (!data) return null;
    const entryId = myResults?.entry?.id ?? myEntryId;
    if (entryId != null) {
      const r = data.standings.find(s => s.id === entryId);
      if (r) return r;
    }
    if (user?.displayName) {
      const lower = user.displayName.trim().toLowerCase();
      return data.standings.find(s => s.playerName.trim().toLowerCase() === lower) ?? null;
    }
    return null;
  }, [data, myEntryId, myResults, user]);

  const isAlreadyRegistered = !!myStanding;
  const canRegister = !!data && !isAlreadyRegistered && (data.status === "open" || data.status === "active" || data.status === "draft");

  const onRegister = useCallback(async () => {
    if (!data) return;
    if (!isAuthenticated || !token) {
      Alert.alert("Sign in required", "Please sign in to join this ladder.", [
        { text: "Cancel", style: "cancel" },
        { text: "Sign in", onPress: () => router.push("/(auth)/login") },
      ]);
      return;
    }
    setRegistering(true);
    try {
      const res = await fetch(`${BASE_URL}/api/cross-club-ladders/${data.id}/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "x-client-type": "mobile",
        },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({})) as { id?: number; error?: string };
      if (!res.ok) {
        Alert.alert("Could not join", body.error ?? `Request failed (${res.status}).`);
        return;
      }
      if (typeof body.id === "number") setMyEntryId(body.id);
      Alert.alert("You're in!", `You've joined ${data.name}. Qualifying rounds played at participating clubs will count automatically.`);
      await queryClient.invalidateQueries({ queryKey: ["public-ladder", slug] });
      await Promise.all([refetch(), refetchMyResults()]);
    } catch (e) {
      Alert.alert("Network error", (e as Error).message ?? "Please try again.");
    } finally {
      setRegistering(false);
    }
  }, [data, isAuthenticated, token, queryClient, slug, refetch]);

  if (isLoading) {
    return (
      <View style={[styles.container, styles.center]} testID="ladder-loading">
        <Stack.Screen options={{ title: "Ladder" }} />
        <LoadingSpinner size="large" color={Colors.primary} />
      </View>
    );
  }
  if (error || !data) {
    return (
      <View style={[styles.container, styles.center]}>
        <Stack.Screen options={{ title: "Ladder" }} />
        <Feather name="alert-triangle" size={32} color={Colors.error} />
        <Text style={styles.errorText}>{(error as Error)?.message ?? "Ladder not found."}</Text>
        <Pressable onPress={() => router.back()} style={styles.linkBtn}>
          <Text style={styles.linkBtnText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  const groupedByDivision = new Map<number, StandingRow[]>();
  for (const s of data.standings) {
    const arr = groupedByDivision.get(s.division) ?? [];
    arr.push(s);
    groupedByDivision.set(s.division, arr);
  }
  const divisions = Array.from(groupedByDivision.keys()).sort((a, b) => a - b);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]} testID="ladder-screen">
      <Stack.Screen options={{ title: data.name, headerShown: false }} />

      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn} testID="ladder-back">
          <Feather name="chevron-left" size={24} color={Colors.text} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{data.name}</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        refreshControl={
          <RefreshControl
            refreshing={isFetchingResults}
            onRefresh={async () => {
              await Promise.all([refetch(), refetchMyResults()]);
            }}
            tintColor={Colors.primary}
          />
        }
      >
        <View style={styles.summaryCard}>
          <View style={styles.row}>
            <Feather name="award" size={16} color={Colors.primary} />
            <Text style={styles.summaryTitle}>
              {data.scope === "national" ? "National Ladder" : `Regional${data.region ? ` • ${data.region}` : ""}`}
              {" • "}{FORMAT_LABEL[data.format] ?? data.format}
            </Text>
          </View>
          <Text style={styles.summaryMeta}>{formatDateRange(data.seasonStart, data.seasonEnd)}</Text>
          {data.description ? <Text style={styles.summaryDesc}>{data.description}</Text> : null}

          <View style={styles.statusRow}>
            <View style={[
              styles.statusPill,
              data.status === "active" ? styles.pillActive
                : data.status === "completed" ? styles.pillDone
                : styles.pillOpen,
            ]}>
              <Text style={styles.pillText}>{data.status.toUpperCase()}</Text>
            </View>
            {data.bestOfRounds != null ? (
              <Text style={styles.metaChip}>Best of {data.bestOfRounds} rounds</Text>
            ) : null}
            {data.divisionCount > 1 ? (
              <Text style={styles.metaChip}>{data.divisionCount} divisions</Text>
            ) : null}
          </View>

          {(data.minHandicap || data.maxHandicap) ? (
            <Text style={styles.eligibility}>
              Eligibility: handicap{" "}
              {data.minHandicap ?? "—"} to {data.maxHandicap ?? "—"}
            </Text>
          ) : null}
        </View>

        {/* Registration CTA */}
        <View style={styles.ctaCard}>
          {isAlreadyRegistered ? (
            <View style={styles.row}>
              <Feather name="check-circle" size={18} color="#059669" />
              <Text style={styles.ctaRegisteredText}>
                You're registered{myStanding?.position ? ` — currently #${myStanding.position}` : ""}.
              </Text>
            </View>
          ) : canRegister ? (
            <Pressable
              onPress={onRegister}
              disabled={registering}
              style={({ pressed }) => [
                styles.ctaButton,
                pressed && { opacity: 0.85 },
                registering && { opacity: 0.6 },
              ]}
              testID="ladder-register-btn"
            >
              {registering ? (
                <LoadingSpinner size="small" color="#fff" />
              ) : (
                <>
                  <Feather name="user-plus" size={16} color="#fff" />
                  <Text style={styles.ctaButtonText}>Join this ladder</Text>
                </>
              )}
            </Pressable>
          ) : (
            <Text style={styles.ctaClosedText}>
              Registration is closed for this ladder.
            </Text>
          )}
          {!isAuthenticated && canRegister ? (
            <Text style={styles.ctaHint}>You'll be asked to sign in.</Text>
          ) : null}
        </View>

        {/* Player's qualifying-round history */}
        {isAuthenticated && myResults?.entry ? (
          <View style={styles.section} testID="my-rounds-section">
            <Text style={styles.sectionTitle}>Your Qualifying Rounds</Text>
            {data.bestOfRounds != null ? (
              <Text style={styles.historyHint}>
                Best {data.bestOfRounds} rounds count toward your total ({myResults.entry.roundsCounted} counted so far).
              </Text>
            ) : (
              <Text style={styles.historyHint}>
                {myResults.entry.roundsCounted} round{myResults.entry.roundsCounted === 1 ? "" : "s"} counted toward your total.
              </Text>
            )}
            {myResults.results.length === 0 ? (
              <Text style={styles.emptyText}>
                No qualifying rounds yet — play a round at a participating club to add one.
              </Text>
            ) : (
              myResults.results.map(r => {
                let dateLabel = r.roundDate;
                try {
                  dateLabel = new Date(r.roundDate).toLocaleDateString(undefined, {
                    month: "short", day: "numeric", year: "numeric",
                  });
                } catch { /* keep raw */ }
                const onOpen = r.tournamentId
                  ? () => router.push({ pathname: "/(tabs)/leaderboard", params: { tournamentId: String(r.tournamentId) } })
                  : r.generalPlayRoundId
                    ? () => router.push(`/general-play/${r.generalPlayRoundId}`)
                    : null;
                const sourceLabel = r.tournamentId
                  ? "  •  Tournament"
                  : r.generalPlayRoundId
                    ? "  •  General play"
                    : "";
                const inner = (
                  <>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.historyDate}>{dateLabel}</Text>
                      <Text style={styles.historyClub} numberOfLines={1}>
                        {r.orgName ?? "Club"}
                        {sourceLabel}
                      </Text>
                    </View>
                    <View style={{ alignItems: "flex-end" }}>
                      <Text style={styles.historyPoints}>{r.pointsAwarded} pts</Text>
                      <View style={[
                        styles.countedPill,
                        r.countedTowardTotal ? styles.countedPillYes : styles.countedPillNo,
                      ]}>
                        <Text style={[
                          styles.countedPillText,
                          r.countedTowardTotal ? styles.countedPillTextYes : styles.countedPillTextNo,
                        ]}>
                          {r.countedTowardTotal ? "COUNTED" : "NOT COUNTED"}
                        </Text>
                      </View>
                    </View>
                    {onOpen ? (
                      <Feather
                        name="chevron-right"
                        size={18}
                        color={Colors.textSecondary}
                        style={{ marginLeft: 4 }}
                      />
                    ) : null}
                  </>
                );
                if (onOpen) {
                  return (
                    <Pressable
                      key={r.id}
                      onPress={onOpen}
                      style={({ pressed }) => [
                        styles.historyRow,
                        pressed && { opacity: 0.6 },
                      ]}
                      testID={`my-round-${r.id}`}
                      accessibilityRole="button"
                      accessibilityLabel={
                        r.tournamentId
                          ? `Open tournament leaderboard for ${dateLabel}`
                          : `Open scorecard for ${dateLabel}`
                      }
                    >
                      {inner}
                    </Pressable>
                  );
                }
                return (
                  <View
                    key={r.id}
                    style={styles.historyRow}
                    testID={`my-round-${r.id}`}
                  >
                    {inner}
                  </View>
                );
              })
            )}
          </View>
        ) : null}

        {/* Participating clubs */}
        {data.clubs.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Participating Clubs</Text>
            <View style={styles.clubChipRow}>
              {data.clubs.map(c => (
                <View key={c.organizationId} style={styles.clubChip}>
                  <Text style={styles.clubChipText} numberOfLines={1}>{c.orgName ?? "Club"}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* Standings */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Standings</Text>
          {data.standings.length === 0 ? (
            <Text style={styles.emptyText}>No standings yet — be the first to register.</Text>
          ) : (
            divisions.map(div => (
              <View key={div} style={{ marginTop: 8 }}>
                {data.divisionCount > 1 ? (
                  <Text style={styles.divisionLabel}>Division {div}</Text>
                ) : null}
                {(groupedByDivision.get(div) ?? []).map(row => {
                  const mine = myStanding?.id === row.id;
                  return (
                    <View
                      key={row.id}
                      style={[styles.standingRow, mine && styles.standingRowMine]}
                      testID={mine ? "ladder-mine" : `ladder-row-${row.id}`}
                    >
                      <Text style={[styles.posText, mine && styles.mineText]}>{row.position ?? "—"}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.playerName, mine && styles.mineText]} numberOfLines={1}>
                          {row.playerName}{mine ? "  (you)" : ""}
                        </Text>
                        {row.orgName ? (
                          <Text style={styles.playerOrg} numberOfLines={1}>{row.orgName}</Text>
                        ) : null}
                      </View>
                      <View style={{ alignItems: "flex-end" }}>
                        <Text style={[styles.pointsText, mine && styles.mineText]}>{row.totalPoints} pts</Text>
                        <Text style={styles.roundsText}>{row.roundsCounted} rounds</Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { alignItems: "center", justifyContent: "center", padding: 24 },
  errorText: { color: Colors.text, marginTop: 8, textAlign: "center" },
  linkBtn: { marginTop: 12, padding: 10 },
  linkBtnText: { color: Colors.primary, fontWeight: "600" },

  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
    backgroundColor: Colors.card,
  },
  backBtn: { padding: 4 },
  headerTitle: { color: Colors.text, fontSize: 16, fontWeight: "700", flex: 1, textAlign: "center" },

  summaryCard: {
    backgroundColor: Colors.card, margin: 12, padding: 14, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.border, gap: 6,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  summaryTitle: { color: Colors.text, fontSize: 14, fontWeight: "700" },
  summaryMeta: { color: Colors.textSecondary, fontSize: 12 },
  summaryDesc: { color: Colors.text, fontSize: 13, marginTop: 4, lineHeight: 18 },
  statusRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 8 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
  pillText: { color: "#fff", fontSize: 10, fontWeight: "700" },
  pillActive: { backgroundColor: "#059669" },
  pillDone: { backgroundColor: "#475569" },
  pillOpen: { backgroundColor: "#d97706" },
  metaChip: {
    fontSize: 11, color: Colors.textSecondary,
    backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4,
  },
  eligibility: { color: Colors.textSecondary, fontSize: 12, marginTop: 4 },

  ctaCard: {
    marginHorizontal: 12, marginBottom: 12, padding: 14, borderRadius: 12,
    backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border, gap: 6,
  },
  ctaButton: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: Colors.primary, paddingVertical: 12, borderRadius: 8,
  },
  ctaButtonText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  ctaRegisteredText: { color: "#059669", fontSize: 14, fontWeight: "600" },
  ctaClosedText: { color: Colors.textSecondary, fontSize: 13, textAlign: "center" },
  ctaHint: { color: Colors.textSecondary, fontSize: 11, textAlign: "center", marginTop: 4 },

  section: { marginHorizontal: 12, marginBottom: 12, padding: 14, borderRadius: 12, backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border },
  sectionTitle: { color: Colors.text, fontSize: 14, fontWeight: "700", marginBottom: 6 },
  clubChipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  clubChip: { backgroundColor: Colors.background, borderWidth: 1, borderColor: Colors.border, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, maxWidth: "100%" },
  clubChipText: { color: Colors.text, fontSize: 12 },

  divisionLabel: { color: Colors.textSecondary, fontSize: 11, fontWeight: "700", textTransform: "uppercase", marginTop: 8, marginBottom: 4 },
  standingRow: {
    flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8,
    borderTopWidth: 1, borderTopColor: Colors.border,
  },
  standingRowMine: {
    backgroundColor: Colors.primary + "15",
    borderRadius: 8,
    paddingHorizontal: 8,
    borderTopWidth: 0,
    marginVertical: 2,
  },
  posText: { width: 28, textAlign: "center", color: Colors.textSecondary, fontSize: 14, fontWeight: "700" },
  playerName: { color: Colors.text, fontSize: 13, fontWeight: "600" },
  playerOrg: { color: Colors.textSecondary, fontSize: 11, marginTop: 1 },
  pointsText: { color: Colors.text, fontSize: 13, fontWeight: "700" },
  roundsText: { color: Colors.textSecondary, fontSize: 11 },
  mineText: { color: Colors.primary },
  emptyText: { color: Colors.textSecondary, fontSize: 12, fontStyle: "italic" },

  historyHint: { color: Colors.textSecondary, fontSize: 12, marginBottom: 4 },
  historyRow: {
    flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: Colors.border,
  },
  historyDate: { color: Colors.text, fontSize: 13, fontWeight: "600" },
  historyClub: { color: Colors.textSecondary, fontSize: 11, marginTop: 2 },
  historyPoints: { color: Colors.text, fontSize: 13, fontWeight: "700" },
  countedPill: {
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginTop: 4,
    borderWidth: 1,
  },
  countedPillYes: { backgroundColor: "#05966915", borderColor: "#059669" },
  countedPillNo: { backgroundColor: Colors.background, borderColor: Colors.border },
  countedPillText: { fontSize: 9, fontWeight: "700", letterSpacing: 0.5 },
  countedPillTextYes: { color: "#059669" },
  countedPillTextNo: { color: Colors.textSecondary },
});
