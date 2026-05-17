import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import Colors from "@/constants/colors";
import { getLocale } from "@/i18n";

const GOLD = "#C9A84C";

interface WHSState {
  handicapIndex: string | null;
  lowHandicapIndex: string | null;
  scoringRecordCount: number;
  phase: number;
  softCapApplied: boolean;
  hardCapApplied: boolean;
  lastCalculatedAt: string | null;
  eligible: boolean;
  establishedAt: string | null;
}

interface ScoreRecord {
  id: number;
  differential: string;
  grossScore: number;
  adjustedGrossScore: number | null;
  courseRating: string | null;
  slopeRating: number | null;
  holesPlayed: number;
  playedAt: string;
  source: string;
  isExceptional: boolean;
  usedForHandicap: boolean;
  courseName: string | null;
  tournamentName: string | null;
}

const phaseDesc: Record<number, string> = {
  0: "Not yet established",
  1: "Initialisation (1–3 scores)",
  2: "Soft cap phase (4–19 scores)",
  3: "Established (20+ scores)",
};

export default function HandicapProfileScreen() {
  const { token } = useAuth();
  const { activeClub } = useActiveClub();
  const orgId = activeClub?.id;
  const baseUrl = process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
    : "";

  const [state, setState] = useState<WHSState | null>(null);
  const [records, setRecords] = useState<ScoreRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    if (!orgId || !token) return;
    try {
      const [stateRes, recRes] = await Promise.all([
        fetch(`${baseUrl}/api/portal/whs/state?organizationId=${orgId}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`${baseUrl}/api/portal/whs/records?organizationId=${orgId}&limit=40`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);
      if (stateRes.ok) setState(await stateRes.json());
      if (recRes.ok) setRecords(await recRes.json());
    } catch { /* ignore */ } finally { setLoading(false); setRefreshing(false); }
  }

  useEffect(() => { load(); }, [orgId, token]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [orgId, token]);

  const sourceLabel = (s: string) => {
    if (s === "tournament") return "Tournament";
    if (s === "general_play") return "General Play";
    return s;
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={{ padding: 4 }}>
          <Feather name="chevron-left" size={24} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>My Handicap</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={GOLD} />}
      >
        {loading ? (
          <LoadingSpinner color={GOLD} style={{ marginTop: 60 }} />
        ) : (
          <>
            {/* HI Card */}
            <View style={styles.hiCard}>
              <Text style={styles.hiLabel}>WHS Handicap Index</Text>
              <Text style={styles.hiValue}>
                {state?.handicapIndex != null
                  ? Number(state.handicapIndex).toFixed(1)
                  : state?.eligible === false ? "Not Eligible" : "N/A"
                }
              </Text>
              {state?.lowHandicapIndex != null && (
                <Text style={styles.hiLow}>Low H.I.: {Number(state.lowHandicapIndex).toFixed(1)}</Text>
              )}
              {state && (
                <Text style={styles.phaseText}>{phaseDesc[state.phase] ?? ""}</Text>
              )}
              {state && (
                <View style={styles.hiMeta}>
                  <View style={styles.hiMetaItem}>
                    <Text style={styles.hiMetaVal}>{state.scoringRecordCount}</Text>
                    <Text style={styles.hiMetaLbl}>Scores</Text>
                  </View>
                  {state.softCapApplied && (
                    <View style={[styles.hiMetaItem, styles.capBadge]}>
                      <Feather name="alert-triangle" size={12} color="#f59e0b" />
                      <Text style={styles.capText}>Soft Cap</Text>
                    </View>
                  )}
                  {state.hardCapApplied && (
                    <View style={[styles.hiMetaItem, styles.hardCapBadge]}>
                      <Feather name="alert-circle" size={12} color="#ef4444" />
                      <Text style={styles.hardCapText}>Hard Cap</Text>
                    </View>
                  )}
                </View>
              )}
              {state?.lastCalculatedAt && (
                <Text style={styles.hiUpdated}>
                  Updated: {new Date(state.lastCalculatedAt).toLocaleDateString(getLocale(), { day: "numeric", month: "short", year: "numeric" })}
                </Text>
              )}
            </View>

            {/* WHS Phase explanation */}
            {state && state.phase < 3 && state.eligible !== false && (
              <View style={styles.infoCard}>
                <Feather name="info" size={14} color={GOLD} />
                <Text style={styles.infoText}>
                  {state.phase === 0
                    ? "Post your first score to start establishing your Handicap Index."
                    : state.phase === 1
                    ? `Post ${3 - state.scoringRecordCount} more accepted score${3 - state.scoringRecordCount !== 1 ? "s" : ""} to receive an initial H.I.`
                    : `${20 - state.scoringRecordCount} more scores needed to reach a fully established H.I.`
                  }
                </Text>
              </View>
            )}

            {/* Score records */}
            <Text style={styles.sectionTitle}>Scoring Record</Text>
            {records.length === 0 ? (
              <View style={styles.empty}>
                <Feather name="activity" size={28} color={Colors.muted} />
                <Text style={styles.emptyText}>No scores posted yet</Text>
              </View>
            ) : (
              records.map(r => (
                <View
                  key={r.id}
                  style={[styles.scoreRow, r.usedForHandicap && { borderLeftWidth: 3, borderLeftColor: GOLD }]}
                >
                  <View style={styles.scoreLeft}>
                    <Text style={styles.scoreCourse}>{r.courseName ?? r.tournamentName ?? "Round"}</Text>
                    <Text style={styles.scoreDate}>
                      {new Date(r.playedAt).toLocaleDateString(getLocale(), { day: "numeric", month: "short", year: "numeric" })}
                      {" · "}{sourceLabel(r.source)}
                      {" · "}{r.holesPlayed}H
                    </Text>
                    {r.courseRating != null && r.slopeRating != null && (
                      <Text style={styles.scoreRating}>
                        CR {Number(r.courseRating).toFixed(1)} / SR {r.slopeRating}
                      </Text>
                    )}
                  </View>
                  <View style={styles.scoreRight}>
                    <Text style={styles.scoreDiff}>{Number(r.differential).toFixed(1)}</Text>
                    <Text style={styles.scoreDiffLabel}>Diff</Text>
                    {r.isExceptional && (
                      <View style={styles.exceptBadge}><Text style={styles.exceptText}>E</Text></View>
                    )}
                  </View>
                </View>
              ))
            )}

            <View style={{ height: 24 }} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  title: { flex: 1, fontSize: 20, fontWeight: "700", color: Colors.text },
  scroll: { flex: 1 },
  hiCard: { backgroundColor: Colors.surface, marginHorizontal: 16, borderRadius: 16, padding: 24, alignItems: "center", marginBottom: 12, borderWidth: 1, borderColor: `${GOLD}40` },
  hiLabel: { color: Colors.muted, fontSize: 12, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 },
  hiValue: { fontSize: 64, fontWeight: "800", color: GOLD, lineHeight: 72 },
  hiLow: { color: Colors.muted, fontSize: 13, marginTop: 4 },
  phaseText: { color: Colors.muted, fontSize: 12, marginTop: 6, textAlign: "center" },
  hiMeta: { flexDirection: "row", gap: 12, marginTop: 12, alignItems: "center" },
  hiMetaItem: { alignItems: "center" },
  hiMetaVal: { color: Colors.text, fontSize: 18, fontWeight: "700" },
  hiMetaLbl: { color: Colors.muted, fontSize: 11 },
  capBadge: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#f59e0b20", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  capText: { color: "#f59e0b", fontSize: 12, fontWeight: "600" },
  hardCapBadge: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#ef444420", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  hardCapText: { color: "#ef4444", fontSize: 12, fontWeight: "600" },
  hiUpdated: { color: Colors.muted, fontSize: 11, marginTop: 12 },
  infoCard: { flexDirection: "row", gap: 8, alignItems: "flex-start", backgroundColor: `${GOLD}10`, marginHorizontal: 16, borderRadius: 10, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: `${GOLD}30` },
  infoText: { flex: 1, color: Colors.text, fontSize: 13, lineHeight: 18 },
  sectionTitle: { fontSize: 13, fontWeight: "600", color: Colors.muted, textTransform: "uppercase", letterSpacing: 0.5, marginHorizontal: 16, marginBottom: 8, marginTop: 4 },
  scoreRow: { flexDirection: "row", alignItems: "center", backgroundColor: Colors.surface, marginHorizontal: 16, borderRadius: 10, padding: 14, marginBottom: 6, borderWidth: 1, borderColor: Colors.border },
  scoreLeft: { flex: 1 },
  scoreCourse: { color: Colors.text, fontSize: 14, fontWeight: "600" },
  scoreDate: { color: Colors.muted, fontSize: 11, marginTop: 2 },
  scoreRating: { color: Colors.muted, fontSize: 11, marginTop: 1 },
  scoreRight: { alignItems: "flex-end" },
  scoreDiff: { color: GOLD, fontSize: 20, fontWeight: "700" },
  scoreDiffLabel: { color: Colors.muted, fontSize: 11 },
  exceptBadge: { backgroundColor: "#f59e0b30", borderRadius: 4, padding: 2, marginTop: 4 },
  exceptText: { color: "#f59e0b", fontSize: 10, fontWeight: "700" },
  empty: { alignItems: "center", padding: 32 },
  emptyText: { color: Colors.muted, fontSize: 15, marginTop: 10 },
});
