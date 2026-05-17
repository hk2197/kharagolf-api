import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView } from "react-native";
import { Feather } from "@expo/vector-icons";
import { fetchPublic, BASE_URL } from "@/utils/api";

type OddsPayload = {
  tournamentId: number;
  winProbability: Array<{ playerId: number; name: string; scoreToPar: number | null; winProbability: number }>;
  expectedScores: Array<{ holeNumber: number; par: number; expectedStrokes: number; scoringAverageVsPar: number }>;
  biggestSwings: Array<{ playerId: number; name: string; delta: number; round: number; holeNumber: number; strokes: number; par: number }>;
  disclosure: string;
};

interface Props {
  tournamentId: number;
  surface?: string;
}

export default function LiveOddsWidget({ tournamentId, surface = "mobile_leaderboard" }: Props) {
  const [data, setData] = useState<OddsPayload | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancel = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const ctrl = new AbortController();

    async function init() {
      // Initial snapshot — also exercises gating/auth so we can hide on 403/404.
      try {
        const json = await fetchPublic<OddsPayload>(`/tournaments/${tournamentId}/odds`);
        if (cancel) return;
        setData(json);
        fetch(`${BASE_URL}/api/public/tournaments/${tournamentId}/odds/telemetry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventType: "impression", widget: "win_probability", surface }),
        }).catch(() => {});
      } catch {
        if (!cancel) setHidden(true);
        return;
      }
      void connectStream();
    }

    // Subscribe to the SSE stream — server pushes a fresh payload on every
    // leaderboard update, so no polling interval is required.
    async function connectStream() {
      try {
        const res = await fetch(
          `${BASE_URL}/api/public/tournaments/${tournamentId}/odds/stream`,
          { signal: ctrl.signal },
        );
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const part of parts) {
            const dataLine = part.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            try {
              const parsed = JSON.parse(dataLine.slice(5).trim()) as {
                type?: string;
                data?: OddsPayload;
              };
              if (parsed.type === "odds_update" && parsed.data && !cancel) {
                setData(parsed.data);
              }
            } catch { /* ignore malformed events */ }
          }
        }
      } catch (e: unknown) {
        if ((e as { name?: string })?.name === "AbortError") return;
      }
      // Reconnect on disconnect (server restart, network blip)
      if (!cancel) {
        retryTimer = setTimeout(() => { if (!cancel) void connectStream(); }, 8000);
      }
    }

    init();
    return () => {
      cancel = true;
      ctrl.abort();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [tournamentId, surface]);

  if (hidden) return null;
  if (!data) return null;

  const top = data.winProbability.slice(0, 5);
  const swings = data.biggestSwings.slice(0, 3);

  return (
    <View style={styles.card} testID="live-odds-widget">
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Feather name="activity" size={14} color="#10b981" />
          <Text style={styles.title}>Live insights</Text>
        </View>
        <Text style={styles.disclaimerPill}>Entertainment only</Text>
      </View>

      <Text style={styles.sectionLabel}>Win probability</Text>
      <View style={{ gap: 4 }}>
        {top.length === 0 ? (
          <Text style={styles.emptyText}>No active players yet.</Text>
        ) : top.map((p, i) => (
          <View key={p.playerId} style={styles.row}>
            <Text style={styles.rank}>{i + 1}</Text>
            <Text style={styles.name} numberOfLines={1}>{p.name}</Text>
            <Text style={styles.toPar}>
              {p.scoreToPar == null ? "—" : p.scoreToPar > 0 ? `+${p.scoreToPar}` : p.scoreToPar === 0 ? "E" : String(p.scoreToPar)}
            </Text>
            <Text style={styles.prob}>{(p.winProbability * 100).toFixed(1)}%</Text>
          </View>
        ))}
      </View>

      {swings.length > 0 && (
        <>
          <Text style={[styles.sectionLabel, { marginTop: 10 }]}>Biggest swings</Text>
          {swings.map((s, i) => (
            <View key={`${s.playerId}-${s.round}-${s.holeNumber}-${i}`} style={styles.row}>
              <Feather
                name={s.delta > 0 ? "trending-down" : "trending-up"}
                size={12}
                color={s.delta > 0 ? "#ef4444" : "#10b981"}
              />
              <Text style={styles.name} numberOfLines={1}>{s.name}</Text>
              <Text style={styles.toPar}>R{s.round} H{s.holeNumber}</Text>
              <Text style={[styles.prob, { color: s.delta > 0 ? "#ef4444" : "#10b981" }]}>
                {s.delta > 0 ? "+" : ""}{s.delta.toFixed(2)}
              </Text>
            </View>
          ))}
        </>
      )}

      <Text style={styles.disclosure}>{data.disclosure}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 12,
    marginVertical: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "rgba(16, 185, 129, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.25)",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 6 },
  title: { color: "#a7f3d0", fontWeight: "700", fontSize: 13 },
  disclaimerPill: {
    color: "#fbbf24",
    fontSize: 9,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    backgroundColor: "rgba(251, 191, 36, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(251, 191, 36, 0.4)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
  },
  sectionLabel: {
    color: "#94a3b8",
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 3 },
  rank: { color: "#64748b", fontSize: 11, width: 16 },
  name: { color: "#e2e8f0", fontSize: 12, flex: 1, fontWeight: "500" },
  toPar: { color: "#94a3b8", fontSize: 11, width: 50, textAlign: "right" },
  prob: { color: "#10b981", fontSize: 12, fontWeight: "700", width: 56, textAlign: "right" },
  emptyText: { color: "#94a3b8", fontSize: 12 },
  disclosure: { color: "#94a3b8", fontSize: 10, marginTop: 8, lineHeight: 14 },
});
