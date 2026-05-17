import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  Alert,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { router } from "expo-router";
import { Feather, Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/context/auth";
import Colors from "@/constants/colors";

const BASE_URL = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : "";

type RoleType =
  | "starter"
  | "marshal"
  | "scorer"
  | "registration"
  | "first_aid"
  | "transport"
  | "other";

const ROLE_ICONS: Record<RoleType, string> = {
  starter: "flag",
  marshal: "shield",
  scorer: "edit-2",
  registration: "clipboard",
  first_aid: "heart",
  transport: "truck",
  other: "users",
};

const ROLE_LABELS: Record<RoleType, string> = {
  starter: "Starter",
  marshal: "Marshal",
  scorer: "Scorer",
  registration: "Registration",
  first_aid: "First Aid",
  transport: "Transport",
  other: "Other",
};

interface VolunteerAssignment {
  id: number;
  roleId: number;
  tournamentId: number;
  roleTitle: string;
  roleType: RoleType;
  roleLocation: string | null;
  qrToken: string;
  tournamentName: string;
  tournamentStartDate: string | null;
  checkedIn: boolean;
}

export default function StaffingScreen() {
  const { token } = useAuth();
  const [assignments, setAssignments] = useState<VolunteerAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${BASE_URL}/api/portal/staffing/my-assignments`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error("Failed");
      const d = await r.json() as { volunteerAssignments: VolunteerAssignment[] };
      setAssignments(d.volunteerAssignments ?? []);
    } catch {
      Alert.alert("Error", "Could not load your staffing assignments.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = () => { setRefreshing(true); load(); };

  function formatDate(d: string | null) {
    if (!d) return "TBD";
    return new Date(d).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <LoadingSpinner color={Colors.primary} size="large" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Feather name="arrow-left" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Staffing</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.primary} />}
        contentContainerStyle={assignments.length === 0 ? styles.emptyContainer : styles.listContainer}
      >
        {assignments.length === 0 && (
          <View style={styles.emptyBox}>
            <Feather name="users" size={48} color={Colors.textSecondary} />
            <Text style={styles.emptyTitle}>No Assignments</Text>
            <Text style={styles.emptyText}>
              You have no volunteer or marshal assignments. When a tournament director assigns you to a role, it will appear here.
            </Text>
          </View>
        )}

        {assignments.map((a) => (
          <TouchableOpacity
            key={a.id}
            style={styles.card}
            onPress={() =>
              router.push({
                pathname: "/staffing/[id]",
                params: { id: a.id.toString(), qrToken: a.qrToken },
              })
            }
            activeOpacity={0.8}
          >
            <View style={styles.cardHeader}>
              <View style={[styles.iconBadge, a.checkedIn && styles.iconBadgeChecked]}>
                <Feather
                  name={(ROLE_ICONS[a.roleType] as unknown) as keyof typeof Feather.glyphMap}
                  size={20}
                  color={a.checkedIn ? Colors.primary : Colors.textSecondary}
                />
              </View>
              <View style={styles.cardInfo}>
                <Text style={styles.cardTitle}>{a.roleTitle}</Text>
                <Text style={styles.cardSub}>{ROLE_LABELS[a.roleType]}</Text>
              </View>
              {a.checkedIn ? (
                <View style={styles.checkedBadge}>
                  <Feather name="check-circle" size={14} color={Colors.primary} />
                  <Text style={styles.checkedText}>Checked In</Text>
                </View>
              ) : (
                <Feather name="chevron-right" size={18} color={Colors.textSecondary} />
              )}
            </View>

            <View style={styles.cardMeta}>
              <View style={styles.metaRow}>
                <Feather name="flag" size={13} color={Colors.textSecondary} />
                <Text style={styles.metaText}>{a.tournamentName}</Text>
              </View>
              <View style={styles.metaRow}>
                <Feather name="calendar" size={13} color={Colors.textSecondary} />
                <Text style={styles.metaText}>{formatDate(a.tournamentStartDate)}</Text>
              </View>
              {a.roleLocation && (
                <View style={styles.metaRow}>
                  <Feather name="map-pin" size={13} color={Colors.textSecondary} />
                  <Text style={styles.metaText}>{a.roleLocation}</Text>
                </View>
              )}
            </View>

            {!a.checkedIn && (
              <View style={styles.qrHint}>
                <Ionicons name="qr-code-outline" size={14} color={Colors.primary} />
                <Text style={styles.qrHintText}>Tap to view QR check-in</Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: Colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backBtn: { width: 40, height: 40, justifyContent: "center" },
  headerTitle: { fontSize: 18, fontWeight: "700", color: Colors.text },
  listContainer: { padding: 16, gap: 12 },
  emptyContainer: { flex: 1, justifyContent: "center", alignItems: "center", padding: 32 },
  emptyBox: { alignItems: "center", gap: 12 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: Colors.text },
  emptyText: { fontSize: 14, color: Colors.textSecondary, textAlign: "center", lineHeight: 20 },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 10,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  iconBadge: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: Colors.border,
    justifyContent: "center",
    alignItems: "center",
  },
  iconBadgeChecked: { backgroundColor: `${Colors.primary}20` },
  cardInfo: { flex: 1 },
  cardTitle: { fontSize: 16, fontWeight: "600", color: Colors.text },
  cardSub: { fontSize: 13, color: Colors.textSecondary, marginTop: 2 },
  checkedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: `${Colors.primary}20`,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  checkedText: { fontSize: 12, color: Colors.primary, fontWeight: "600" },
  cardMeta: { gap: 4, paddingLeft: 4 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  metaText: { fontSize: 13, color: Colors.textSecondary },
  qrHint: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingTop: 10,
  },
  qrHintText: { fontSize: 13, color: Colors.primary, fontWeight: "500" },
});
