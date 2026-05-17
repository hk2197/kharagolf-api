import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  StyleSheet,
  Platform,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather, Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { fetchPortal, postPortal, getApiUrl } from "@/utils/api";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";
import { useTranslation } from "react-i18next";
import { RoundRobinStandings } from "@/components/RoundRobinStandings";

// ─── Types ────────────────────────────────────────────────────────────────

type Player = {
  id: number;
  firstName: string;
  lastName: string;
  handicapIndex?: string | null;
};

type BracketMatch = {
  id: number;
  roundId: number;
  matchNumber: number;
  result: string;
  matchStatus?: string | null;
  holeResults?: Record<string, string>;
  player1?: Player | null;
  player2?: Player | null;
  player1Id?: number | null;
  player2Id?: number | null;
  player1IsBye?: boolean;
  player2IsBye?: boolean;
  bracketType?: string;
  winnerId?: number | null;
};

type BracketRound = {
  id: number;
  name: string;
  bracketType: string;
  roundNumber: number;
};

type BracketData = {
  bracket: {
    id: number;
    tournamentId: number;
    totalRounds: number;
    hasConsolation: boolean;
    drawGeneratedAt?: string | null;
    format?: string;
    tieBreakRule?: string | null;
    championId?: number | null;
    runnerUpId?: number | null;
    completedAt?: string | null;
  } | null;
  rounds: BracketRound[];
  matches: BracketMatch[];
};

type RyderMatch = {
  id: number;
  sessionId: number;
  matchNumber: number;
  result: string;
  team1Points: string;
  team2Points: string;
  matchStatus?: string | null;
  holeResults?: Record<string, string>;
  team1Player1?: Player | null;
  team1Player2?: Player | null;
  team2Player1?: Player | null;
  team2Player2?: Player | null;
};

type RyderSession = {
  id: number;
  sessionNumber: number;
  name: string;
  sessionType: string;
  team1Name: string;
  team2Name: string;
};

type RyderConfig = {
  team1Name: string;
  team2Name: string;
  team1Colour: string;
  team2Colour: string;
  totalPoints: number;
  team1TotalPoints: string;
  team2TotalPoints: string;
};

type RyderData = {
  config: RyderConfig | null;
  sessions: RyderSession[];
  matches: RyderMatch[];
  runningTotals: { team1: number; team2: number };
};

// ─── Helpers ──────────────────────────────────────────────────────────────

function playerName(p?: Player | null): string {
  if (!p) return "TBD";
  return `${p.firstName} ${p.lastName}`;
}

function playerInitials(p?: Player | null): string {
  if (!p) return "?";
  return `${p.firstName.charAt(0)}${p.lastName.charAt(0)}`.toUpperCase();
}

function ChampionBanner({
  champion,
  runnerUp,
  completedAt,
}: {
  champion: Player;
  runnerUp?: Player | null;
  completedAt?: string | null;
}) {
  const completedLabel = completedAt
    ? new Date(completedAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;
  return (
    <View testID="champion-banner" style={styles.championBanner}>
      <View style={styles.championAvatar} testID="champion-avatar">
        <Text style={styles.championAvatarText}>{playerInitials(champion)}</Text>
        <View style={styles.championCrown}>
          <Feather name="award" size={14} color="#78350f" />
        </View>
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.championBadge}>
          <Feather name="star" size={10} color="#fde68a" />
          <Text style={styles.championBadgeText}>Champion Crowned</Text>
        </View>
        <Text style={styles.championName} testID="champion-name">
          {playerName(champion)}
        </Text>
        <View style={styles.championMeta}>
          {runnerUp && (
            <View style={styles.runnerUpPill} testID="runner-up-name">
              <Feather name="award" size={10} color="#cbd5e1" />
              <Text style={styles.runnerUpLabel}>Runner-up</Text>
              <Text style={styles.runnerUpName}>{playerName(runnerUp)}</Text>
            </View>
          )}
          {completedLabel && (
            <Text style={styles.championCompleted}>Completed {completedLabel}</Text>
          )}
        </View>
      </View>
    </View>
  );
}

function holeResultColor(r?: string): string {
  if (r === "player1" || r === "team1") return "#22c55e";
  if (r === "player2" || r === "team2") return "#ef4444";
  if (r === "halved") return "#eab308";
  return "#6b7280";
}

// Mirror of the web bracket UI: figure out which playoff holes (19+) to expose
// for entry given the current hole results and the bracket's tie-break rule.
function computePlayoffHoles(
  holeResults: Record<string, string> | undefined,
  tieBreakRule: "sudden_death" | "extra_holes_3",
): number[] {
  const get = (h: number) => holeResults?.[String(h)];
  const out: number[] = [];
  if (tieBreakRule === "extra_holes_3") {
    out.push(19, 20, 21);
    let pp1 = 0, pp2 = 0, complete = 0;
    for (const h of [19, 20, 21]) {
      const r = get(h);
      if (!r) continue;
      complete++;
      if (r === "player1") pp1++;
      else if (r === "player2") pp2++;
    }
    if (complete === 3 && pp1 === pp2) {
      let h = 22;
      while (get(h)) {
        out.push(h);
        if (get(h) === "player1" || get(h) === "player2") return out;
        h++;
      }
      out.push(h);
    }
    return out;
  }
  // sudden_death: render holes 19+ through first decisive entry, plus next blank hole
  let h = 19;
  while (get(h)) {
    out.push(h);
    if (get(h) === "player1" || get(h) === "player2") return out;
    h++;
  }
  out.push(h);
  return out;
}

function isTiedAt18(holeResults: Record<string, string> | undefined): boolean {
  if (!holeResults) return false;
  let p1 = 0, p2 = 0, played = 0;
  for (let h = 1; h <= 18; h++) {
    const r = holeResults[String(h)];
    if (!r) continue;
    played++;
    if (r === "player1") p1++;
    else if (r === "player2") p2++;
  }
  return played === 18 && p1 === p2;
}

// ─── Tournament picker ────────────────────────────────────────────────────

type Tournament = {
  id: number;
  name: string;
  format: string;
  status: string;
};

function useTournaments(orgId?: number) {
  return useQuery<Tournament[]>({
    queryKey: ["match-play-tournaments", orgId],
    queryFn: async () => {
      if (!orgId) return [];
      const url = getApiUrl(`/organizations/${orgId}/tournaments?status=active,upcoming`);
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch tournaments");
      const data = await res.json();
      const list: Tournament[] = Array.isArray(data) ? data : (data.tournaments ?? []);
      return list.filter((t) =>
        t.format === "match_play_bracket" || t.format === "ryder_cup"
      );
    },
    enabled: !!orgId,
  });
}

// ─── Head-to-head Form Guide ──────────────────────────────────────────────

type FormGuideData = {
  playerA: number;
  playerB: number;
  record: { aWins: number; bWins: number; halved: number; total: number };
  matches: Array<{
    id: number;
    winnerId: number | null;
    result: string;
    matchStatus: string | null;
    completedAt: string | null;
  }>;
};

function FormGuide({ playerAId, playerBId, playerAName, playerBName }: {
  playerAId: number; playerBId: number; playerAName: string; playerBName: string;
}) {
  const [open, setOpen] = useState(false);
  const q = useQuery<FormGuideData>({
    queryKey: ["form-guide", playerAId, playerBId],
    enabled: open,
    queryFn: async () => {
      const url = getApiUrl(`/match-play/form-guide?playerA=${playerAId}&playerB=${playerBId}`);
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("form guide failed");
      return res.json();
    },
  });

  return (
    <View style={{ marginTop: 10, padding: 10, borderRadius: 8, backgroundColor: "rgba(255,255,255,0.04)", borderWidth: 1, borderColor: "rgba(255,255,255,0.08)" }}>
      <TouchableOpacity
        testID={`form-guide-toggle-${playerAId}-${playerBId}`}
        onPress={() => setOpen((o) => !o)}
        style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
      >
        <Feather name="bar-chart-2" size={14} color="#fbbf24" />
        <Text style={{ color: "#fbbf24", fontSize: 12, fontWeight: "600" }}>
          {open ? "Hide form guide" : "Show form guide"}
        </Text>
      </TouchableOpacity>
      {open && (
        <View style={{ marginTop: 8 }}>
          {q.isLoading ? (
            <LoadingSpinner color={Colors.primary} />
          ) : q.error ? (
            <Text style={{ color: "#ef4444", fontSize: 11 }}>Couldn't load history.</Text>
          ) : !q.data || q.data.record.total === 0 ? (
            <Text style={{ color: "#9ca3af", fontSize: 11 }}>No prior matches between these players.</Text>
          ) : (
            <View>
              <Text style={{ color: "#e5e7eb", fontSize: 12 }} testID={`form-guide-record-${playerAId}-${playerBId}`}>
                <Text style={{ fontWeight: "700", color: "#22c55e" }}>{playerAName}</Text>
                {" "}{q.data.record.aWins}–{q.data.record.bWins}
                {q.data.record.halved > 0 ? ` (½ ${q.data.record.halved})` : ""}{" "}
                <Text style={{ fontWeight: "700", color: "#ef4444" }}>{playerBName}</Text>
              </Text>
              <Text style={{ color: "#6b7280", fontSize: 10, marginTop: 2 }}>
                Across {q.data.record.total} previous match{q.data.record.total === 1 ? "" : "es"}
              </Text>
              {q.data.matches.slice(0, 5).map((m) => (
                <Text key={m.id} style={{ color: "#9ca3af", fontSize: 10, marginTop: 2 }}>
                  {m.completedAt ? new Date(m.completedAt).toLocaleDateString() : "—"} · {m.winnerId === playerAId ? `${playerAName} won` : m.winnerId === playerBId ? `${playerBName} won` : "halved"}{m.matchStatus ? ` (${m.matchStatus})` : ""}
                </Text>
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

// ─── Bracket View ─────────────────────────────────────────────────────────

export function BracketView({ orgId, tournamentId, focusMatchId }: { orgId: number; tournamentId: number; focusMatchId?: number | null }) {
  const queryClient = useQueryClient();
  const { t } = useTranslation("matchPlay");
  const [selectedMatchId, setSelectedMatchId] = useState<number | null>(null);
  const [holeInput, setHoleInput] = useState<{ hole: number; result: "player1" | "player2" | "halved" } | null>(null);

  // Task #899 — when navigated here from a tie-break push notification,
  // scroll to and highlight the target match once its card has rendered.
  // We can't rely on each card's local `onLayout.y` because matches live
  // inside nested round containers (and there is content above them like
  // RoundRobinStandings), so the y is relative to the immediate parent
  // rather than the ScrollView's content. Instead we keep a ref to each
  // match View and measure it against the screen, then translate that to
  // a content offset using the ScrollView's own screen position and the
  // current scroll offset.
  const scrollRef = useRef<ScrollView | null>(null);
  const matchRefs = useRef<Map<number, View>>(new Map());
  const scrollOffsetRef = useRef(0);
  const [highlightedMatchId, setHighlightedMatchId] = useState<number | null>(null);
  const focusedRef = useRef<number | null>(null);
  useEffect(() => {
    if (focusMatchId == null) return;
    if (focusedRef.current === focusMatchId) return;
    focusedRef.current = focusMatchId;
    setHighlightedMatchId(focusMatchId);
    const tryScroll = (attempt: number) => {
      const target = matchRefs.current.get(focusMatchId);
      const sv = scrollRef.current;
      if (target && sv) {
        // Use measureInWindow on both the ScrollView and the target card
        // to get screen coords, then convert to a content offset.
        // @ts-expect-error — measureInWindow exists on the host component.
        sv.measureInWindow((_sx: number, sy: number) => {
          target.measureInWindow((_tx: number, ty: number) => {
            const delta = ty - sy;
            const next = Math.max(0, scrollOffsetRef.current + delta - 24);
            sv.scrollTo({ y: next, animated: true });
          });
        });
        return;
      }
      if (attempt < 25) setTimeout(() => tryScroll(attempt + 1), 100);
    };
    setTimeout(() => tryScroll(0), 150);
    const off = setTimeout(() => setHighlightedMatchId(null), 3500);
    return () => clearTimeout(off);
  }, [focusMatchId]);

  const bracketQuery = useQuery<BracketData>({
    queryKey: ["bracket-mobile", tournamentId, orgId],
    queryFn: async () => {
      const url = getApiUrl(`/organizations/${orgId}/tournaments/${tournamentId}/bracket`);
      const res = await fetch(url, { credentials: "include" });
      if (res.status === 404) return { bracket: null, rounds: [], matches: [] };
      if (!res.ok) throw new Error("Failed to fetch bracket");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const recordHole = useMutation({
    mutationFn: async ({
      matchId,
      holeNumber,
      holeResult,
    }: { matchId: number; holeNumber: number; holeResult: string }) => {
      const url = getApiUrl(`/organizations/${orgId}/tournaments/${tournamentId}/bracket/matches/${matchId}/hole`);
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holeNumber, holeResult }),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bracket-mobile", tournamentId, orgId] });
      setHoleInput(null);
    },
    onError: () => Alert.alert(t("error"), t("failedRecordHole")),
  });

  const recordResult = useMutation({
    mutationFn: async ({
      matchId,
      result,
      concededByPlayerId,
    }: { matchId: number; result: string; concededByPlayerId?: number }) => {
      const url = getApiUrl(`/organizations/${orgId}/tournaments/${tournamentId}/bracket/matches/${matchId}/result`);
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result, concededByPlayerId }),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bracket-mobile", tournamentId, orgId] });
      setSelectedMatchId(null);
    },
    onError: () => Alert.alert(t("error"), t("failedRecordMatch")),
  });

  const data = bracketQuery.data;
  if (bracketQuery.isLoading) {
    return (
      <View style={styles.center}>
        <LoadingSpinner color={Colors.primary} />
      </View>
    );
  }
  if (!data?.bracket) {
    return (
      <View style={styles.center}>
        <Feather name="git-branch" size={40} color="#4b5563" />
        <Text style={styles.emptyText}>{t("noBracket")}</Text>
        <Text style={styles.emptySubtext}>{t("noBracketSub")}</Text>
      </View>
    );
  }
  if (!data.bracket.drawGeneratedAt) {
    return (
      <View style={styles.center}>
        <Feather name="shuffle" size={40} color="#4b5563" />
        <Text style={styles.emptyText}>{t("drawNotGenerated")}</Text>
      </View>
    );
  }

  const mainRounds = data.rounds.filter((r) => r.bracketType === "main");
  const isRoundRobin = data.bracket.format === "round_robin";
  const tieBreakRule = (data.bracket.tieBreakRule ?? "sudden_death") as "sudden_death" | "extra_holes_3" | "none";
  const playoffEnabled = !isRoundRobin && tieBreakRule !== "none";

  return (
    <ScrollView
      ref={scrollRef}
      contentContainerStyle={{ paddingBottom: 40 }}
      scrollEventThrottle={16}
      onScroll={(e) => { scrollOffsetRef.current = e.nativeEvent.contentOffset.y; }}
    >
      {isRoundRobin && data.bracket.completedAt && data.bracket.championId && (() => {
        const championId = data.bracket.championId;
        const runnerUpId = data.bracket.runnerUpId;
        const champion =
          data.matches.find((m) => m.player1?.id === championId)?.player1 ||
          data.matches.find((m) => m.player2?.id === championId)?.player2 ||
          null;
        const runnerUp = runnerUpId
          ? (data.matches.find((m) => m.player1?.id === runnerUpId)?.player1 ||
             data.matches.find((m) => m.player2?.id === runnerUpId)?.player2 ||
             null)
          : null;
        if (!champion) return null;
        return (
          <ChampionBanner
            champion={champion}
            runnerUp={runnerUp}
            completedAt={data.bracket.completedAt}
          />
        );
      })()}
      {isRoundRobin && (
        <RoundRobinStandings
          matches={data.matches.map((m) => ({
            id: m.id,
            bracketType: m.bracketType ?? "main",
            player1Id: m.player1Id ?? m.player1?.id ?? null,
            player2Id: m.player2Id ?? m.player2?.id ?? null,
            player1IsBye: !!m.player1IsBye,
            player2IsBye: !!m.player2IsBye,
            result: m.result,
            winnerId: m.winnerId ?? null,
            holeResults: m.holeResults ?? null,
            player1: m.player1 ?? null,
            player2: m.player2 ?? null,
          }))}
          bracket={data.bracket}
        />
      )}
      {mainRounds.map((round) => {
        const matches = data.matches.filter((m) => m.roundId === round.id);
        return (
          <View key={round.id} style={styles.roundContainer}>
            <Text style={styles.roundTitle}>{round.name}</Text>
            {matches.map((match) => {
              const isActive = selectedMatchId === match.id;
              const isComplete = match.result !== "pending";
              const p1 = match.player1IsBye ? "BYE" : playerName(match.player1);
              const p2 = match.player2IsBye ? "BYE" : playerName(match.player2);
              const isFocused = highlightedMatchId === match.id;
              return (
                <TouchableOpacity
                  key={match.id}
                  testID={`bracket-match-${match.id}`}
                  ref={(r) => {
                    if (r) matchRefs.current.set(match.id, r as unknown as View);
                    else matchRefs.current.delete(match.id);
                  }}
                  style={[styles.matchCard, isActive && styles.matchCardActive, isComplete && styles.matchCardComplete, isFocused && styles.matchCardFocused]}
                  onPress={() => setSelectedMatchId(isActive ? null : match.id)}
                  disabled={isComplete}
                >
                  <View style={styles.matchHeader}>
                    <Text style={styles.matchNum}>{t("match", { n: match.matchNumber })}</Text>
                    <Text style={[styles.matchStatus, isComplete && { color: "#22c55e" }]}>
                      {isComplete ? t("done") : (match.matchStatus ?? t("allSquare"))}
                    </Text>
                  </View>
                  <View style={styles.playersRow}>
                    <Text style={[styles.playerName, match.result === "player1_wins" && styles.winnerName]}>{p1}</Text>
                    <Text style={styles.vsText}>vs</Text>
                    <Text style={[styles.playerName, match.result === "player2_wins" && styles.winnerName]}>{p2}</Text>
                  </View>

                  {/* Hole results indicator */}
                  {match.holeResults && Object.keys(match.holeResults).length > 0 && (() => {
                    const playoffEntered = Object.keys(match.holeResults ?? {})
                      .map(Number)
                      .filter((h) => h > 18)
                      .sort((a, b) => a - b);
                    const allHoles = [
                      ...Array.from({ length: 18 }, (_, i) => i + 1),
                      ...playoffEntered,
                    ];
                    return (
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
                        <View style={{ flexDirection: "row", gap: 4 }}>
                          {allHoles.map((h) => {
                            const r = match.holeResults?.[h];
                            if (!r) return <View key={h} style={[styles.holeDot, { backgroundColor: "#374151" }]} />;
                            return (
                              <View key={h} style={[styles.holeDot, { backgroundColor: holeResultColor(r), borderWidth: h > 18 ? 1 : 0, borderColor: "#fbbf24" }]}>
                                <Text style={{ color: "#fff", fontSize: 8 }}>{h}</Text>
                              </View>
                            );
                          })}
                        </View>
                      </ScrollView>
                    );
                  })()}

                  {/* Head-to-head form guide */}
                  {isActive && match.player1?.id && match.player2?.id && !match.player1IsBye && !match.player2IsBye && (
                    <FormGuide
                      playerAId={match.player1.id}
                      playerBId={match.player2.id}
                      playerAName={p1}
                      playerBName={p2}
                    />
                  )}

                  {/* Hole scoring UI */}
                  {isActive && !isComplete && (() => {
                    const tied18 = isTiedAt18(match.holeResults);
                    const playoffHolesEntered = Object.keys(match.holeResults ?? {})
                      .map(Number)
                      .filter((h) => h > 18);
                    const serverFlaggedPlayoff = !!match.matchStatus &&
                      (match.matchStatus.includes("Playoff") || match.matchStatus.includes("Sudden Death") || match.matchStatus.includes("playoff"));
                    const showPlayoff = playoffEnabled &&
                      (tied18 || playoffHolesEntered.length > 0 || serverFlaggedPlayoff);
                    const playoffMode: "sudden_death" | "extra_holes_3" =
                      tieBreakRule === "extra_holes_3" ? "extra_holes_3" : "sudden_death";
                    const playoffHoles = showPlayoff
                      ? computePlayoffHoles(match.holeResults, playoffMode)
                      : [];
                    return (
                    <View style={{ marginTop: 12 }}>
                      <Text style={styles.sectionLabel}>{t("recordHoleResult")}</Text>
                      <View style={styles.holeGrid}>
                        {Array.from({ length: 18 }, (_, i) => i + 1).map((h) => {
                          const existing = match.holeResults?.[h];
                          return (
                            <TouchableOpacity
                              key={h}
                              style={[styles.holeBtn, existing && { borderColor: holeResultColor(existing) }]}
                              onPress={() => {
                                Alert.alert(
                                  t("hole", { n: h }),
                                  t("whoWonHole"),
                                  [
                                    { text: p1, onPress: () => recordHole.mutate({ matchId: match.id, holeNumber: h, holeResult: "player1" }) },
                                    { text: p2, onPress: () => recordHole.mutate({ matchId: match.id, holeNumber: h, holeResult: "player2" }) },
                                    { text: t("halved"), onPress: () => recordHole.mutate({ matchId: match.id, holeNumber: h, holeResult: "halved" }) },
                                    { text: t("cancel"), style: "cancel" },
                                  ]
                                );
                              }}
                            >
                              <Text style={[styles.holeBtnText, existing && { color: holeResultColor(existing) }]}>{h}</Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>

                      {showPlayoff && (
                        <View style={styles.playoffSection}>
                          <View style={styles.playoffHeader}>
                            <Text style={styles.playoffTitle}>
                              {tieBreakRule === "extra_holes_3" ? t("threeHoleAggregate") : t("suddenDeathPlayoff")}
                            </Text>
                            <Text style={styles.playoffSubtitle}>{t("tiedAt18EnterExtra")}</Text>
                          </View>
                          <View style={styles.holeGrid}>
                            {playoffHoles.map((h) => {
                              const existing = match.holeResults?.[h];
                              return (
                                <TouchableOpacity
                                  key={h}
                                  style={[styles.holeBtn, styles.playoffHoleBtn, existing && { borderColor: holeResultColor(existing) }]}
                                  onPress={() => {
                                    Alert.alert(
                                      t("hole", { n: h }),
                                      t("whoWonHole"),
                                      [
                                        { text: p1, onPress: () => recordHole.mutate({ matchId: match.id, holeNumber: h, holeResult: "player1" }) },
                                        { text: p2, onPress: () => recordHole.mutate({ matchId: match.id, holeNumber: h, holeResult: "player2" }) },
                                        { text: t("halved"), onPress: () => recordHole.mutate({ matchId: match.id, holeNumber: h, holeResult: "halved" }) },
                                        { text: t("cancel"), style: "cancel" },
                                      ]
                                    );
                                  }}
                                >
                                  <Text style={[styles.holeBtnText, { color: existing ? holeResultColor(existing) : "#fbbf24" }]}>{h}</Text>
                                </TouchableOpacity>
                              );
                            })}
                          </View>
                          <Text style={styles.playoffHint}>{t("playoffAutoResolve")}</Text>
                        </View>
                      )}

                      {/* Final result actions */}
                      <View style={styles.resultActions}>
                        <TouchableOpacity
                          style={[styles.resultBtn, { backgroundColor: "rgba(34,197,94,0.15)", borderColor: "#22c55e" }]}
                          onPress={() => {
                            Alert.alert(
                              t("finalResult"),
                              t("whoWonMatch"),
                              [
                                { text: p1, onPress: () => recordResult.mutate({ matchId: match.id, result: "player1_wins" }) },
                                { text: p2, onPress: () => recordResult.mutate({ matchId: match.id, result: "player2_wins" }) },
                                { text: t("halved"), onPress: () => recordResult.mutate({ matchId: match.id, result: "halved" }) },
                                { text: t("cancel"), style: "cancel" },
                              ]
                            );
                          }}
                        >
                          <Feather name="check-circle" size={14} color="#22c55e" />
                          <Text style={[styles.resultBtnText, { color: "#22c55e" }]}>{t("recordResult")}</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                          style={[styles.resultBtn, { backgroundColor: "rgba(239,68,68,0.1)", borderColor: "#ef4444" }]}
                          onPress={() => {
                            Alert.alert(
                              t("concedeMatch"),
                              t("whichPlayerConcedes"),
                              [
                                {
                                  text: p1,
                                  onPress: () => recordResult.mutate({
                                    matchId: match.id,
                                    result: "conceded",
                                    concededByPlayerId: match.player1?.id,
                                  }),
                                },
                                {
                                  text: p2,
                                  onPress: () => recordResult.mutate({
                                    matchId: match.id,
                                    result: "conceded",
                                    concededByPlayerId: match.player2?.id,
                                  }),
                                },
                                { text: t("cancel"), style: "cancel" },
                              ]
                            );
                          }}
                        >
                          <Feather name="flag" size={14} color="#ef4444" />
                          <Text style={[styles.resultBtnText, { color: "#ef4444" }]}>{t("concede")}</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                    );
                  })()}
                </TouchableOpacity>
              );
            })}
          </View>
        );
      })}
    </ScrollView>
  );
}

// ─── Ryder Cup View ───────────────────────────────────────────────────────

function RyderCupView({ orgId, tournamentId }: { orgId: number; tournamentId: number }) {
  const queryClient = useQueryClient();
  const { t } = useTranslation("matchPlay");

  const ryderQuery = useQuery<RyderData>({
    queryKey: ["ryder-mobile", tournamentId, orgId],
    queryFn: async () => {
      const url = getApiUrl(`/organizations/${orgId}/tournaments/${tournamentId}/ryder-cup`);
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch Ryder Cup data");
      return res.json();
    },
    refetchInterval: 15000,
  });

  const recordHole = useMutation({
    mutationFn: async ({ matchId, holeNumber, holeResult }: { matchId: number; holeNumber: number; holeResult: string }) => {
      const url = getApiUrl(`/organizations/${orgId}/tournaments/${tournamentId}/ryder-cup/matches/${matchId}/hole`);
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holeNumber, holeResult }),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ryder-mobile", tournamentId, orgId] });
    },
    onError: () => Alert.alert(t("error"), t("failedRecordHole")),
  });

  const data = ryderQuery.data;
  if (ryderQuery.isLoading) {
    return (
      <View style={styles.center}>
        <LoadingSpinner color={Colors.primary} />
      </View>
    );
  }
  if (!data?.config) {
    return (
      <View style={styles.center}>
        <Feather name="shield" size={40} color="#4b5563" />
        <Text style={styles.emptyText}>{t("notConfigured")}</Text>
        <Text style={styles.emptySubtext}>{t("ryderCupNotConfigured")}</Text>
      </View>
    );
  }

  const { config, sessions, matches, runningTotals } = data;

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
      {/* Team Scoreboard */}
      <View style={styles.scoreboard}>
        <View style={styles.teamScore}>
          <Text style={[styles.teamPoints, { color: config.team1Colour ?? "#1e40af" }]}>
            {runningTotals.team1}
          </Text>
          <Text style={styles.teamName}>{config.team1Name}</Text>
        </View>
        <View style={styles.teamDivider}>
          <Text style={styles.vsLabel}>{t("ptsToWin", { n: Math.ceil(config.totalPoints / 2 + 0.5) })}</Text>
        </View>
        <View style={styles.teamScore}>
          <Text style={[styles.teamPoints, { color: config.team2Colour ?? "#dc2626" }]}>
            {runningTotals.team2}
          </Text>
          <Text style={styles.teamName}>{config.team2Name}</Text>
        </View>
      </View>

      {/* Sessions & Matches */}
      {sessions.map((session) => {
        const sessionMatches = matches.filter((m) => m.sessionId === session.id);
        return (
          <View key={session.id} style={styles.roundContainer}>
            <View style={styles.sessionHeader}>
              <Text style={styles.roundTitle}>{session.name}</Text>
              <Text style={styles.sessionType}>
                {session.sessionType === "foursomes" ? t("foursomes") : session.sessionType === "four_ball" ? t("fourBall") : t("singles")}
              </Text>
            </View>
            {sessionMatches.length === 0 && (
              <Text style={[styles.emptySubtext, { marginLeft: 12 }]}>{t("noMatchesInSession")}</Text>
            )}
            {sessionMatches.map((match) => {
              const isSingles = session.sessionType === "singles";
              const t1Name = isSingles
                ? playerName(match.team1Player1)
                : `${playerName(match.team1Player1)} / ${playerName(match.team1Player2)}`;
              const t2Name = isSingles
                ? playerName(match.team2Player1)
                : `${playerName(match.team2Player1)} / ${playerName(match.team2Player2)}`;
              const isComplete = match.result !== "pending";

              return (
                <View key={match.id} style={[styles.matchCard, isComplete && styles.matchCardComplete]}>
                  <View style={styles.matchHeader}>
                    <Text style={styles.matchNum}>{t("match", { n: match.matchNumber })}</Text>
                    <Text style={[styles.matchStatus, isComplete && { color: "#22c55e" }]}>
                      {isComplete
                        ? match.result === "player1_wins" ? t("winsOnePt", { team: config.team1Name }) : match.result === "player2_wins" ? t("winsOnePt", { team: config.team2Name }) : t("halvedHalfPt")
                        : (match.matchStatus ?? t("allSquare"))}
                    </Text>
                  </View>
                  <View style={styles.playersRow}>
                    <Text style={[styles.playerName, { color: config.team1Colour ?? "#1e40af" }]}>{t1Name}</Text>
                    <View style={styles.scoreDisplay}>
                      <Text style={styles.scoreText}>
                        {match.team1Points} – {match.team2Points}
                      </Text>
                    </View>
                    <Text style={[styles.playerName, { color: config.team2Colour ?? "#dc2626", textAlign: "right" }]}>{t2Name}</Text>
                  </View>

                  {/* Hole scoring for live matches */}
                  {!isComplete && (
                    <View style={{ marginTop: 8 }}>
                      <Text style={styles.sectionLabel}>{t("tapHoleToScore")}</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        <View style={{ flexDirection: "row", gap: 4 }}>
                          {Array.from({ length: 18 }, (_, i) => i + 1).map((h) => {
                            const r = match.holeResults?.[h];
                            return (
                              <TouchableOpacity
                                key={h}
                                style={[styles.holeBtn, r && { borderColor: holeResultColor(r), backgroundColor: holeResultColor(r) + "22" }]}
                                onPress={() => {
                                  Alert.alert(
                                    t("hole", { n: h }),
                                    t("whoWonHole"),
                                    [
                                      { text: config.team1Name, onPress: () => recordHole.mutate({ matchId: match.id, holeNumber: h, holeResult: "team1" }) },
                                      { text: config.team2Name, onPress: () => recordHole.mutate({ matchId: match.id, holeNumber: h, holeResult: "team2" }) },
                                      { text: t("halved"), onPress: () => recordHole.mutate({ matchId: match.id, holeNumber: h, holeResult: "halved" }) },
                                      { text: t("cancel"), style: "cancel" },
                                    ]
                                  );
                                }}
                              >
                                <Text style={[styles.holeBtnText, r && { color: holeResultColor(r) }]}>{h}</Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      </ScrollView>
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        );
      })}
    </ScrollView>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────

export default function MatchPlayScreen() {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation("matchPlay");
  const { user } = useAuth();
  const orgId = user?.organizationId;

  // Task #899 — deep-link params from a tie-break notification tap.
  // tournamentId selects the bracket; focusMatchId is forwarded to
  // BracketView so it can scroll/highlight the new tie-break match.
  const params = useLocalSearchParams<{ tournamentId?: string; focusMatchId?: string }>();
  const paramTournamentId = params.tournamentId ? Number(params.tournamentId) : null;
  const paramFocusMatchId = params.focusMatchId ? Number(params.focusMatchId) : null;

  const [selectedTournamentId, setSelectedTournamentId] = useState<number | null>(null);
  const [selectedFormat, setSelectedFormat] = useState<string>("");

  const tournamentsQuery = useTournaments(orgId);
  const tournaments = tournamentsQuery.data ?? [];

  const selectedTournament = tournaments.find((tourn) => tourn.id === selectedTournamentId);

  // Auto-select the deep-linked tournament once tournaments are loaded so
  // BracketView mounts with the right id (and the focus highlight kicks in).
  const autoSelectedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!paramTournamentId) return;
    if (autoSelectedRef.current === paramTournamentId) return;
    const t = tournaments.find((x) => x.id === paramTournamentId);
    if (t) {
      autoSelectedRef.current = paramTournamentId;
      setSelectedTournamentId(t.id);
      setSelectedFormat(t.format);
    }
  }, [paramTournamentId, tournaments]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Feather name="git-branch" size={22} color={Colors.primary} />
        <Text style={styles.headerTitle}>{t("title")}</Text>
      </View>

      {/* Tournament picker */}
      {tournaments.length === 0 && !tournamentsQuery.isLoading && (
        <View style={styles.center}>
          <Feather name="calendar" size={40} color="#4b5563" />
          <Text style={styles.emptyText}>{t("noEvents")}</Text>
          <Text style={styles.emptySubtext}>{t("noEventsSub")}</Text>
        </View>
      )}

      {tournamentsQuery.isLoading && (
        <View style={styles.center}>
          <LoadingSpinner color={Colors.primary} />
        </View>
      )}

      {tournaments.length > 0 && (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tournamentPicker}>
            {tournaments.map((tourn) => (
              <TouchableOpacity
                key={tourn.id}
                style={[styles.tournamentChip, selectedTournamentId === tourn.id && styles.tournamentChipActive]}
                onPress={() => {
                  setSelectedTournamentId(tourn.id);
                  setSelectedFormat(tourn.format);
                }}
              >
                <Text style={[styles.tournamentChipText, selectedTournamentId === tourn.id && { color: "#fff" }]}>
                  {tourn.name}
                </Text>
                <Text style={[styles.formatLabel, selectedTournamentId === tourn.id && { color: "#86efac" }]}>
                  {tourn.format === "match_play_bracket" ? t("bracket") : t("ryderCup")}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {!selectedTournamentId && (
            <View style={styles.center}>
              <Text style={styles.emptyText}>{t("selectTournament")}</Text>
            </View>
          )}

          {selectedTournamentId && orgId && selectedFormat === "match_play_bracket" && (
            <BracketView
              orgId={orgId}
              tournamentId={selectedTournamentId}
              focusMatchId={paramTournamentId === selectedTournamentId ? paramFocusMatchId : null}
            />
          )}
          {selectedTournamentId && orgId && selectedFormat === "ryder_cup" && (
            <RyderCupView orgId={orgId} tournamentId={selectedTournamentId} />
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f172a",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  headerTitle: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "700",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 8,
  },
  emptyText: {
    color: "#e5e7eb",
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
  emptySubtext: {
    color: "#6b7280",
    fontSize: 13,
    textAlign: "center",
  },
  tournamentPicker: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    maxHeight: 80,
  },
  tournamentChip: {
    marginRight: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
  },
  tournamentChipActive: {
    backgroundColor: "rgba(16,185,129,0.18)",
    borderColor: "#10b981",
  },
  tournamentChipText: {
    color: "#9ca3af",
    fontSize: 13,
    fontWeight: "600",
  },
  formatLabel: {
    color: "#6b7280",
    fontSize: 10,
    marginTop: 2,
  },
  roundContainer: {
    marginTop: 16,
    paddingHorizontal: 12,
  },
  roundTitle: {
    color: "#d1d5db",
    fontSize: 14,
    fontWeight: "700",
    marginBottom: 8,
    letterSpacing: 0.5,
  },
  sessionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  sessionType: {
    color: "#6b7280",
    fontSize: 11,
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  matchCard: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  matchCardActive: {
    borderColor: "#10b981",
    backgroundColor: "rgba(16,185,129,0.06)",
  },
  matchCardComplete: {
    borderColor: "rgba(34,197,94,0.2)",
    opacity: 0.8,
  },
  matchCardFocused: {
    borderColor: "#fbbf24",
    borderWidth: 2,
    backgroundColor: "rgba(251,191,36,0.10)",
  },
  matchHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  matchNum: {
    color: "#6b7280",
    fontSize: 11,
    fontWeight: "600",
  },
  matchStatus: {
    color: "#eab308",
    fontSize: 11,
    fontWeight: "600",
  },
  playersRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  playerName: {
    color: "#f3f4f6",
    fontSize: 13,
    fontWeight: "600",
    flex: 1,
  },
  winnerName: {
    color: "#22c55e",
  },
  vsText: {
    color: "#6b7280",
    fontSize: 11,
  },
  scoreDisplay: {
    alignItems: "center",
  },
  scoreText: {
    color: "#f3f4f6",
    fontSize: 14,
    fontWeight: "700",
  },
  holeDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  holeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 6,
  },
  holeBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    backgroundColor: "rgba(255,255,255,0.04)",
    alignItems: "center",
    justifyContent: "center",
  },
  holeBtnText: {
    color: "#9ca3af",
    fontSize: 11,
    fontWeight: "600",
  },
  sectionLabel: {
    color: "#6b7280",
    fontSize: 11,
    marginBottom: 4,
  },
  scoreboard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(255,255,255,0.04)",
    marginHorizontal: 12,
    marginTop: 16,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  teamScore: {
    alignItems: "center",
    flex: 1,
  },
  teamPoints: {
    fontSize: 40,
    fontWeight: "800",
  },
  teamName: {
    color: "#9ca3af",
    fontSize: 13,
    marginTop: 4,
    fontWeight: "600",
  },
  teamDivider: {
    alignItems: "center",
    paddingHorizontal: 12,
  },
  vsLabel: {
    color: "#6b7280",
    fontSize: 11,
  },
  resultActions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
  },
  resultBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  resultBtnText: {
    fontSize: 12,
    fontWeight: "600",
  },
  playoffSection: {
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(251, 191, 36, 0.4)",
    backgroundColor: "rgba(251, 191, 36, 0.06)",
    gap: 8,
  },
  playoffHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  playoffTitle: {
    color: "#fbbf24",
    fontSize: 12,
    fontWeight: "700",
  },
  playoffSubtitle: {
    color: "rgba(251, 191, 36, 0.8)",
    fontSize: 10,
  },
  playoffHoleBtn: {
    borderColor: "rgba(251, 191, 36, 0.5)",
    backgroundColor: "rgba(251, 191, 36, 0.08)",
  },
  playoffHint: {
    color: "rgba(253, 224, 71, 0.7)",
    fontSize: 10,
  },
  championBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginHorizontal: 12,
    marginTop: 12,
    marginBottom: 4,
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(250, 204, 21, 0.4)",
    backgroundColor: "rgba(245, 158, 11, 0.12)",
  },
  championAvatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#fbbf24",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  championAvatarText: {
    color: "#78350f",
    fontSize: 22,
    fontWeight: "800",
  },
  championCrown: {
    position: "absolute",
    top: -4,
    right: -4,
    backgroundColor: "#fde047",
    borderRadius: 12,
    padding: 4,
  },
  championBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(250, 204, 21, 0.5)",
    backgroundColor: "rgba(250, 204, 21, 0.15)",
  },
  championBadgeText: {
    color: "#fde68a",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  championName: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "800",
    marginTop: 6,
  },
  championMeta: {
    marginTop: 8,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
  },
  runnerUpPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  runnerUpLabel: {
    color: "#94a3b8",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  runnerUpName: {
    color: "#e2e8f0",
    fontSize: 12,
    fontWeight: "600",
  },
  championCompleted: {
    color: "rgba(254, 240, 138, 0.8)",
    fontSize: 11,
  },
});
