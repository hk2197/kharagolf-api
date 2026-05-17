import React, { useMemo } from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import {
  computeRoundRobinStandings,
  TIE_BREAK_DESCRIPTION,
  type StandingsMatch,
} from "@/utils/round-robin-standings";

type BracketSummary = {
  championId?: number | null;
  runnerUpId?: number | null;
  completedAt?: string | Date | null;
  tieBreakRule?: string | null;
  // Allow extra fields so callers can pass through their bracket object as-is.
  [key: string]: unknown;
} | null | undefined;

export function RoundRobinStandings({
  matches,
  bracket,
}: {
  matches: StandingsMatch[];
  bracket?: BracketSummary;
}) {
  const { t } = useTranslation("matchPlay");
  const standings = useMemo(() => computeRoundRobinStandings(matches), [matches]);

  const championId = bracket?.championId ?? null;
  const runnerUpId = bracket?.runnerUpId ?? null;
  const isComplete = !!bracket?.completedAt && !!championId;
  const topTied = standings[0]?.tied && !isComplete;
  const tieBreakRule = bracket?.tieBreakRule ?? "sudden_death";

  return (
    <View style={styles.card} testID="rr-standings">
      <View style={styles.header}>
        <Feather name="award" size={16} color="#facc15" />
        <Text style={styles.title}>{t("standings")}</Text>
        {isComplete && (
          <View style={styles.completeBadge} testID="rr-complete-badge">
            <Feather name="award" size={11} color="#fde68a" />
            <Text style={styles.completeBadgeText}>Complete</Text>
          </View>
        )}
      </View>
      <Text style={styles.tiebreak}>{TIE_BREAK_DESCRIPTION}</Text>
      {topTied && (
        <Text style={styles.tieBreakPending} testID="rr-tiebreak-pending">
          Top of the table is tied —{" "}
          {tieBreakRule === "extra_holes_3" ? "3-hole playoff" : "sudden-death"} tie-break required.
        </Text>
      )}

      {standings.length === 0 ? (
        <Text style={styles.empty}>{t("standingsEmpty")}</Text>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View>
            <View style={[styles.row, styles.headerRow]}>
              <Text style={[styles.cell, styles.rankCell, styles.headerText]}>#</Text>
              <Text style={[styles.cell, styles.nameCell, styles.headerText]}>{t("player")}</Text>
              <Text style={[styles.cell, styles.numCell, styles.headerText]}>P</Text>
              <Text style={[styles.cell, styles.numCell, styles.headerText]}>W</Text>
              <Text style={[styles.cell, styles.numCell, styles.headerText]}>L</Text>
              <Text style={[styles.cell, styles.numCell, styles.headerText]}>H</Text>
              <Text style={[styles.cell, styles.holesCell, styles.headerText]}>{t("holesWon")}</Text>
              <Text style={[styles.cell, styles.numCell, styles.headerText]}>{t("pts")}</Text>
            </View>
            {standings.map((row) => {
              const isChampion = championId === row.playerId;
              const isRunnerUp = runnerUpId === row.playerId;
              const rowStyle = [
                styles.row,
                isChampion && styles.championRow,
                isRunnerUp && styles.runnerUpRow,
              ];
              return (
                <View
                  key={row.playerId}
                  style={rowStyle}
                  testID={isChampion ? "rr-champion-row" : isRunnerUp ? "rr-runnerup-row" : undefined}
                >
                  <Text style={[styles.cell, styles.rankCell, styles.bodyText]}>{row.rank}</Text>
                  <View style={[styles.cell, styles.nameCell, styles.nameWrap]}>
                    {isChampion && <Feather name="award" size={12} color="#fde68a" />}
                    {isRunnerUp && !isChampion && <Feather name="award" size={12} color="#cbd5e1" />}
                    <Text style={styles.nameText} numberOfLines={1}>
                      {row.player.firstName} {row.player.lastName}
                    </Text>
                  </View>
                  <Text style={[styles.cell, styles.numCell, styles.bodyText]}>{row.played}</Text>
                  <Text style={[styles.cell, styles.numCell, { color: "#22c55e" }]}>{row.wins}</Text>
                  <Text style={[styles.cell, styles.numCell, { color: "#ef4444" }]}>{row.losses}</Text>
                  <Text style={[styles.cell, styles.numCell, { color: "#eab308" }]}>{row.halved}</Text>
                  <Text style={[styles.cell, styles.holesCell, styles.bodyText]}>{row.holesWon}</Text>
                  <Text style={[styles.cell, styles.numCell, styles.ptsText]}>{row.points}</Text>
                </View>
              );
            })}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    padding: 12,
    marginHorizontal: 12,
    marginTop: 12,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 6 },
  title: { color: "#fff", fontSize: 16, fontWeight: "600", marginLeft: 6 },
  tiebreak: { color: "#9ca3af", fontSize: 11, marginTop: 4, marginBottom: 8 },
  tieBreakPending: { color: "#fde68a", fontSize: 11, marginTop: 2, marginBottom: 8 },
  empty: { color: "#9ca3af", fontSize: 13, paddingVertical: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  headerRow: { borderBottomColor: "rgba(255,255,255,0.15)" },
  championRow: { backgroundColor: "rgba(234,179,8,0.10)" },
  runnerUpRow: { backgroundColor: "rgba(203,213,225,0.06)" },
  cell: { fontSize: 13, paddingHorizontal: 6 },
  rankCell: { width: 28, textAlign: "left" },
  nameCell: { width: 140 },
  nameWrap: { flexDirection: "row", alignItems: "center", gap: 4 },
  numCell: { width: 32, textAlign: "right" },
  holesCell: { width: 64, textAlign: "right" },
  headerText: { color: "#9ca3af", fontSize: 11, fontWeight: "500" },
  bodyText: { color: "#d1d5db" },
  nameText: { color: "#fff", fontWeight: "500", fontSize: 13 },
  ptsText: { color: "#fff", fontWeight: "700" },
  completeBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: "rgba(234,179,8,0.10)",
    borderWidth: 1,
    borderColor: "rgba(250,204,21,0.4)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    marginLeft: 6,
  },
  completeBadgeText: { color: "#fde68a", fontSize: 10, fontWeight: "600" },
});
