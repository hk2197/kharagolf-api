/**
 * Mobile Caddie Portal — Caddie views their upcoming assignments
 * Route: /caddies (accessible after login if user has caddie profile)
 */
import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import Colors from "@/constants/colors";

const GOLD = "#C9A84C";

interface Assignment {
  id: number;
  teeBookingId: number;
  status: string;
  feeCharged: string | null;
  tipAmount: string | null;
  notes: string | null;
  slotDate: string | null;
  slotTime: string | null;
  memberName: string | null;
  createdAt: string;
}

const STATUS_LABELS: Record<string, string> = {
  requested: "Requested",
  assigned: "Assigned",
  confirmed: "Confirmed",
  in_progress: "In Progress",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No Show",
};

const STATUS_COLORS: Record<string, string> = {
  requested: "#0ea5e9",
  assigned: "#3b82f6",
  confirmed: "#22c55e",
  in_progress: "#f59e0b",
  completed: "#10b981",
  cancelled: "#ef4444",
  no_show: "#f43f5e",
};

export default function CaddiePortalScreen() {
  const { token } = useAuth();
  const { activeClub } = useActiveClub();
  const orgId = activeClub?.id;
  const baseUrl = process.env.EXPO_PUBLIC_DOMAIN ? `https://${process.env.EXPO_PUBLIC_DOMAIN}` : "";

  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!token) return;
    try {
      setError(null);
      const res = await fetch(`${baseUrl}/api/portal/caddie/assignments`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 404) {
        setError("No caddie profile found. Ask your club admin to link your account.");
        return;
      }
      if (!res.ok) throw new Error("Failed to load");
      const data = await res.json();
      setAssignments(data.assignments ?? []);
    } catch {
      setError("Could not load assignments.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { load(); }, [token]);
  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [token]);

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <LoadingSpinner color={GOLD} size="large" />
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Feather name="alert-circle" size={40} color="#ef4444" />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const upcoming = assignments.filter(a => ["assigned", "confirmed", "in_progress"].includes(a.status));
  const completed = assignments.filter(a => a.status === "completed");

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>My Schedule</Text>
        <Text style={styles.headerSubtitle}>Your caddie assignments</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={GOLD} />}
      >
        {/* Upcoming */}
        <Text style={styles.sectionTitle}>Upcoming ({upcoming.length})</Text>
        {upcoming.length === 0 ? (
          <View style={styles.emptyCard}>
            <Feather name="calendar" size={28} color="rgba(255,255,255,0.2)" />
            <Text style={styles.emptyText}>No upcoming assignments</Text>
          </View>
        ) : (
          upcoming.map(a => <AssignmentCard key={a.id} assignment={a} />)
        )}

        {/* Completed */}
        {completed.length > 0 && (
          <>
            <Text style={[styles.sectionTitle, { marginTop: 24 }]}>Completed ({completed.length})</Text>
            {completed.map(a => <AssignmentCard key={a.id} assignment={a} />)}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function AssignmentCard({ assignment: a }: { assignment: Assignment }) {
  const statusColor = STATUS_COLORS[a.status] ?? "#9ca3af";

  return (
    <View style={styles.card}>
      <View style={styles.cardRow}>
        <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
        <View style={styles.cardInfo}>
          <Text style={styles.cardDate}>
            {a.slotDate ?? "TBD"} {a.slotTime ? `at ${a.slotTime}` : ""}
          </Text>
          {a.memberName && <Text style={styles.cardMember}>Member: {a.memberName}</Text>}
        </View>
        <View style={[styles.statusBadge, { borderColor: statusColor }]}>
          <Text style={[styles.statusText, { color: statusColor }]}>
            {STATUS_LABELS[a.status] ?? a.status}
          </Text>
        </View>
      </View>

      {(a.feeCharged || a.tipAmount) && (
        <View style={styles.feeRow}>
          {a.feeCharged && (
            <View style={styles.feeItem}>
              <Feather name="dollar-sign" size={12} color="rgba(255,255,255,0.4)" />
              <Text style={styles.feeLabel}>Fee: ₹{parseFloat(a.feeCharged).toLocaleString()}</Text>
            </View>
          )}
          {a.tipAmount && (
            <View style={styles.feeItem}>
              <Feather name="gift" size={12} color={GOLD} />
              <Text style={[styles.feeLabel, { color: GOLD }]}>Tip: ₹{parseFloat(a.tipAmount).toLocaleString()}</Text>
            </View>
          )}
        </View>
      )}

      {a.notes && <Text style={styles.notes}>{a.notes}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background ?? "#0f1117" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  errorText: { color: "#ef4444", fontSize: 14, textAlign: "center", paddingHorizontal: 24 },
  header: { paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.06)" },
  headerTitle: { fontSize: 22, fontWeight: "700", color: "#fff" },
  headerSubtitle: { fontSize: 13, color: "rgba(255,255,255,0.4)", marginTop: 2 },
  scroll: { padding: 16, paddingBottom: 40 },
  sectionTitle: { fontSize: 12, fontWeight: "600", color: "rgba(255,255,255,0.4)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 },
  emptyCard: { backgroundColor: "rgba(255,255,255,0.04)", borderRadius: 12, padding: 24, alignItems: "center", gap: 8 },
  emptyText: { color: "rgba(255,255,255,0.3)", fontSize: 14 },
  card: { backgroundColor: "rgba(255,255,255,0.05)", borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: "rgba(255,255,255,0.06)" },
  cardRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  cardInfo: { flex: 1 },
  cardDate: { color: "#fff", fontSize: 14, fontWeight: "600" },
  cardMember: { color: "rgba(255,255,255,0.5)", fontSize: 12, marginTop: 2 },
  statusBadge: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  statusText: { fontSize: 11, fontWeight: "600" },
  feeRow: { flexDirection: "row", gap: 16, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: "rgba(255,255,255,0.06)" },
  feeItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  feeLabel: { color: "rgba(255,255,255,0.5)", fontSize: 12 },
  notes: { color: "rgba(255,255,255,0.4)", fontSize: 12, marginTop: 8, fontStyle: "italic" },
});
