/**
 * National Ladders card — surfaces public cross-club ladders inside the
 * leagues tab. Tapping opens the in-app ladder detail / registration screen
 * (Task #463), where signed-in players can join and see their own position
 * highlighted.
 */
import React, { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { BASE_URL } from "@/utils/api";
import Colors from "@/constants/colors";

interface PublicLadderSummary {
  id: number;
  name: string;
  scope: "regional" | "national";
  format: string;
  status: string;
  region: string | null;
  shareSlug: string;
  seasonStart: string;
  seasonEnd: string;
}

const FORMAT_LABEL: Record<string, string> = {
  stableford: "Stableford",
  stroke: "Stroke",
  team_series: "Team Series",
  knockout_cup: "Knockout Cup",
  national_ladder: "Ladder",
};

export default function NationalLaddersCard() {
  const [ladders, setLadders] = useState<PublicLadderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${BASE_URL}/api/public/cross-club-ladders`);
        if (!res.ok) throw new Error("fetch failed");
        const json = await res.json() as PublicLadderSummary[];
        if (alive) setLadders(json);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, []);

  if (error) return null;
  if (ladders === null) {
    return (
      <View style={styles.card} testID="ladder-card-loading">
        <ActivityIndicator size="small" color={Colors.primary} />
      </View>
    );
  }
  if (ladders.length === 0) return null;

  return (
    <View style={styles.card} testID="ladder-card">
      <View style={styles.header}>
        <Feather name="award" size={16} color={Colors.primary} />
        <Text style={styles.title}>National & Regional Ladders</Text>
      </View>
      <Text style={styles.subtitle}>Cross-club season-long standings</Text>
      <View style={styles.list}>
        {ladders.slice(0, 4).map(l => (
          <Pressable
            key={l.id}
            onPress={() => router.push(`/ladders/${l.shareSlug}`)}
            style={({ pressed }) => [styles.item, pressed && { opacity: 0.7 }]}
            testID={`ladder-item-${l.id}`}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.itemName}>{l.name}</Text>
              <Text style={styles.itemMeta}>
                {l.scope === "national" ? "National" : `Regional${l.region ? ` • ${l.region}` : ""}`}
                {" • "}{FORMAT_LABEL[l.format] ?? l.format}
              </Text>
            </View>
            <View style={[styles.statusPill, l.status === "active" ? styles.pillActive : l.status === "completed" ? styles.pillDone : styles.pillOpen]}>
              <Text style={styles.pillText}>{l.status.toUpperCase()}</Text>
            </View>
            <Feather name="chevron-right" size={18} color={Colors.textSecondary} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.card,
    borderRadius: 12,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: Colors.text, fontSize: 14, fontWeight: "700" },
  subtitle: { color: Colors.textSecondary, fontSize: 12, marginTop: 2, marginBottom: 10 },
  list: { gap: 6 },
  item: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: Colors.border },
  itemName: { color: Colors.text, fontSize: 13, fontWeight: "600" },
  itemMeta: { color: Colors.textSecondary, fontSize: 11, marginTop: 2 },
  statusPill: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  pillText: { color: "#fff", fontSize: 9, fontWeight: "700" },
  pillActive: { backgroundColor: "#059669" },
  pillDone: { backgroundColor: "#475569" },
  pillOpen: { backgroundColor: "#d97706" },
});
