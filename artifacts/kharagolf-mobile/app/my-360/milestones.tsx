import React, { useEffect, useMemo, useState } from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather } from "@expo/vector-icons";
import { useAuth } from "@/context/auth";
import { useTheme } from "@/theme";
import { authedFetch, useActingMemberId, actingQs } from "./_shared";

interface Milestone {
  id: number; milestoneType: string; occurredAt: string;
  courseName: string | null; holeNumber: number | null;
  yardage: number | null; club: string | null; details: string | null;
  verified: boolean;
}

const TYPE_LABELS: Record<string, { label: string; icon: keyof typeof Feather.glyphMap }> = {
  hole_in_one: { label: "Hole in one", icon: "target" },
  eagle: { label: "Eagle", icon: "award" },
  albatross: { label: "Albatross", icon: "star" },
  course_record: { label: "Course record", icon: "trending-up" },
  longest_drive_event: { label: "Longest drive", icon: "wind" },
  club_championship_win: { label: "Championship win", icon: "award" },
  anniversary: { label: "Anniversary", icon: "gift" },
};

export default function MilestonesScreen() {
  const { token } = useAuth();
  const [acting] = useActingMemberId();
  const { tokens } = useTheme();
  const [rows, setRows] = useState<Milestone[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const styles = useMemo(() => StyleSheet.create({
    center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: tokens.colors.background },
    errorText: { color: tokens.colors.error, padding: tokens.spacing.lg, textAlign: "center" },
    empty: { alignItems: "center", padding: 40, gap: tokens.spacing.sm },
    emptyText: { color: tokens.colors.text, fontSize: 14, fontWeight: "600" },
    emptySub: { color: tokens.colors.muted, fontSize: 12, textAlign: "center" },
    card: { flexDirection: "row", gap: tokens.spacing.md, backgroundColor: tokens.colors.surface, borderRadius: tokens.radius.lg, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: tokens.colors.border },
    iconWrap: { width: 40, height: 40, borderRadius: 20, backgroundColor: `${tokens.colors.primary}20`, alignItems: "center", justifyContent: "center" },
    label: { color: tokens.colors.text, fontSize: 14, fontWeight: "700" },
    verified: { width: 16, height: 16, borderRadius: 8, backgroundColor: `${tokens.colors.success}40`, alignItems: "center", justifyContent: "center" },
    date: { color: tokens.colors.muted, fontSize: 11, marginTop: 2 },
    detail: { color: tokens.colors.textSecondary, fontSize: 12, marginTop: 4 },
  }), [tokens]);

  useEffect(() => {
    if (!token) return;
    authedFetch<Milestone[]>(`/api/portal/my-milestones${actingQs({ actingMemberId: acting })}`, token)
      .then(setRows).catch(e => setError((e as Error).message)).finally(() => setLoading(false));
  }, [token, acting]);

  if (loading) return <View style={styles.center}><LoadingSpinner color={tokens.colors.primary} /></View>;
  if (error) return <View style={styles.center}><Text style={styles.errorText}>{error}</Text></View>;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: tokens.colors.background }} contentContainerStyle={{ padding: tokens.spacing.lg }}>
      {rows.length === 0 ? (
        <View style={styles.empty}>
          <Feather name="award" size={32} color={tokens.colors.muted} />
          <Text style={styles.emptyText}>No milestones recorded yet.</Text>
          <Text style={styles.emptySub}>Aces, eagles and other achievements will appear here.</Text>
        </View>
      ) : rows.map(m => {
        const meta = TYPE_LABELS[m.milestoneType] ?? { label: m.milestoneType.replace(/_/g, " "), icon: "star" as const };
        return (
          <View key={m.id} style={styles.card}>
            <View style={styles.iconWrap}><Feather name={meta.icon} size={20} color={tokens.colors.primary} /></View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text style={styles.label}>{meta.label}</Text>
                {m.verified && <View style={styles.verified}><Feather name="check" size={9} color={tokens.colors.success} /></View>}
              </View>
              <Text style={styles.date}>{new Date(m.occurredAt).toLocaleDateString()}</Text>
              {m.courseName && <Text style={styles.detail}>{m.courseName}{m.holeNumber ? ` · Hole ${m.holeNumber}` : ""}{m.yardage ? ` · ${m.yardage}y` : ""}</Text>}
              {m.club && <Text style={styles.detail}>Club: {m.club}</Text>}
              {m.details && <Text style={styles.detail}>{m.details}</Text>}
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}
