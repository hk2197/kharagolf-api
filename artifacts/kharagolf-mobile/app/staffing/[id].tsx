import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Share,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { router, useLocalSearchParams } from "expo-router";
import { Feather, Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import QRCode from "react-native-qrcode-svg";
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

export default function StaffingDetailScreen() {
  const { id, qrToken } = useLocalSearchParams<{ id: string; qrToken: string }>();
  const { token } = useAuth();
  const [assignment, setAssignment] = useState<VolunteerAssignment | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkedIn, setCheckedIn] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const r = await fetch(`${BASE_URL}/api/portal/staffing/my-assignments`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error("Failed");
      const d = await r.json() as { volunteerAssignments: VolunteerAssignment[] };
      const found = d.volunteerAssignments.find(a => a.id === parseInt(id ?? "0"));
      if (found) {
        setAssignment(found);
        setCheckedIn(found.checkedIn);
      }
    } catch {
      Alert.alert("Error", "Could not load assignment details.");
    } finally {
      setLoading(false);
    }
  }, [token, id]);

  useEffect(() => { load(); }, [load]);

  function formatDate(d: string | null) {
    if (!d) return "TBD";
    return new Date(d).toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  }

  async function handleShare() {
    if (!assignment) return;
    await Share.share({
      message: `I'm volunteering as ${assignment.roleTitle} at ${assignment.tournamentName} on ${formatDate(assignment.tournamentStartDate)}`,
    });
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <LoadingSpinner color={Colors.primary} size="large" />
      </View>
    );
  }

  if (!assignment) {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Feather name="arrow-left" size={22} color={Colors.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Assignment</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.center}>
          <Feather name="alert-circle" size={40} color={Colors.textSecondary} />
          <Text style={styles.emptyText}>Assignment not found.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const qrValue = `${BASE_URL}/api/public/staffing/checkin/${assignment.qrToken}`;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Feather name="arrow-left" size={22} color={Colors.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Assignment</Text>
        <TouchableOpacity onPress={handleShare} style={styles.backBtn}>
          <Feather name="share-2" size={20} color={Colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Status banner */}
        {checkedIn ? (
          <View style={styles.checkedBanner}>
            <Feather name="check-circle" size={20} color={Colors.primary} />
            <Text style={styles.checkedBannerText}>You are checked in!</Text>
          </View>
        ) : (
          <View style={styles.pendingBanner}>
            <Ionicons name="time-outline" size={20} color="#f59e0b" />
            <Text style={styles.pendingBannerText}>Not yet checked in — show this QR to the TD</Text>
          </View>
        )}

        {/* Role card */}
        <View style={styles.roleCard}>
          <Text style={styles.roleLabel}>{ROLE_LABELS[assignment.roleType]}</Text>
          <Text style={styles.roleTitle}>{assignment.roleTitle}</Text>

          <View style={styles.divider} />

          <View style={styles.infoRow}>
            <Feather name="flag" size={15} color={Colors.textSecondary} />
            <View>
              <Text style={styles.infoLabel}>Tournament</Text>
              <Text style={styles.infoValue}>{assignment.tournamentName}</Text>
            </View>
          </View>

          <View style={styles.infoRow}>
            <Feather name="calendar" size={15} color={Colors.textSecondary} />
            <View>
              <Text style={styles.infoLabel}>Date</Text>
              <Text style={styles.infoValue}>{formatDate(assignment.tournamentStartDate)}</Text>
            </View>
          </View>

          {assignment.roleLocation && (
            <View style={styles.infoRow}>
              <Feather name="map-pin" size={15} color={Colors.textSecondary} />
              <View>
                <Text style={styles.infoLabel}>Location</Text>
                <Text style={styles.infoValue}>{assignment.roleLocation}</Text>
              </View>
            </View>
          )}
        </View>

        {/* QR Code */}
        {!checkedIn && (
          <View style={styles.qrSection}>
            <Text style={styles.qrTitle}>Check-In QR Code</Text>
            <Text style={styles.qrSubtitle}>Show this to the tournament director to check in</Text>
            <View style={styles.qrBox}>
              <QRCode
                value={qrValue}
                size={220}
                color="#fff"
                backgroundColor="transparent"
              />
            </View>
            <Text style={styles.qrHint}>Role: {assignment.roleTitle}</Text>
          </View>
        )}

        {checkedIn && (
          <View style={styles.historyBox}>
            <Feather name="check-circle" size={48} color={Colors.primary} />
            <Text style={styles.historyTitle}>Check-in Complete</Text>
            <Text style={styles.historyText}>
              Your attendance has been recorded for this event. Thank you for volunteering!
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  center: { flex: 1, justifyContent: "center", alignItems: "center", gap: 12 },
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
  content: { padding: 16, gap: 16 },
  checkedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: `${Colors.primary}20`,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: `${Colors.primary}40`,
  },
  checkedBannerText: { color: Colors.primary, fontWeight: "600", fontSize: 14 },
  pendingBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(245, 158, 11, 0.12)",
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: "rgba(245, 158, 11, 0.3)",
  },
  pendingBannerText: { color: "#f59e0b", fontWeight: "500", fontSize: 14, flex: 1 },
  roleCard: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 12,
  },
  roleLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: Colors.primary,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  roleTitle: { fontSize: 22, fontWeight: "700", color: Colors.text },
  divider: { height: 1, backgroundColor: Colors.border },
  infoRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  infoLabel: { fontSize: 12, color: Colors.textSecondary, marginBottom: 2 },
  infoValue: { fontSize: 15, color: Colors.text, fontWeight: "500" },
  qrSection: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 20,
    alignItems: "center",
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 8,
  },
  qrTitle: { fontSize: 17, fontWeight: "700", color: Colors.text },
  qrSubtitle: { fontSize: 13, color: Colors.textSecondary, textAlign: "center" },
  qrBox: {
    marginVertical: 12,
    padding: 16,
    backgroundColor: "#1a1a2e",
    borderRadius: 16,
  },
  qrHint: { fontSize: 13, color: Colors.textSecondary },
  historyBox: {
    backgroundColor: Colors.surface,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 10,
  },
  historyTitle: { fontSize: 18, fontWeight: "700", color: Colors.text },
  historyText: { fontSize: 14, color: Colors.textSecondary, textAlign: "center", lineHeight: 20 },
  emptyText: { fontSize: 15, color: Colors.textSecondary },
});
