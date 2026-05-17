/**
 * Staff Scheduling — Mobile Screen (Task #110)
 * Accessible to staff members who have a staff_profile linked to their app user account.
 * Shows: upcoming shifts, leave requests + balances, and timesheet history.
 */
import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  Modal,
  TextInput,
  Alert,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather, Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import Colors from "@/constants/colors";

const PRIMARY = Colors.primary;
const GOLD = "#C9A84C";

type LeaveType = "annual" | "sick" | "unpaid" | "personal" | "bereavement" | "public_holiday";
type ShiftStatus = "draft" | "published" | "confirmed" | "cancelled";
type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

interface Shift {
  id: number;
  date: string;
  startTime: string;
  endTime: string;
  department: string;
  role: string | null;
  status: ShiftStatus;
  notes: string | null;
}

interface LeaveRequest {
  id: number;
  leaveType: LeaveType;
  startDate: string;
  endDate: string;
  totalDays: string;
  reason: string | null;
  status: LeaveStatus;
  reviewNotes: string | null;
  createdAt: string;
}

interface TimesheetEntry {
  id: number;
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  totalMinutes: number | null;
  overtimeMinutes: number | null;
  isApproved: boolean;
  isManualEntry: boolean;
}

interface MyLeaveData {
  requests: LeaveRequest[];
  annualBalance: string;
  sickBalance: string;
}

const DEPT_LABELS: Record<string, string> = {
  pro_shop: "Pro Shop",
  food_and_beverage: "F&B",
  grounds: "Grounds",
  reception: "Reception",
  administration: "Admin",
  security: "Security",
  maintenance: "Maintenance",
  other: "Other",
};

const DEPT_COLORS: Record<string, string> = {
  pro_shop: "#22c55e",
  food_and_beverage: "#f97316",
  grounds: "#84cc16",
  reception: "#0ea5e9",
  administration: "#8b5cf6",
  security: "#ef4444",
  maintenance: "#eab308",
  other: "#6b7280",
};

const LEAVE_STATUS_COLORS: Record<LeaveStatus, string> = {
  pending: "#f59e0b",
  approved: "#22c55e",
  rejected: "#ef4444",
  cancelled: "#6b7280",
};

const SHIFT_STATUS_COLORS: Record<ShiftStatus, string> = {
  draft: "#6b7280",
  published: "#0ea5e9",
  confirmed: "#22c55e",
  cancelled: "#ef4444",
};

function fmtMins(mins: number | null | undefined): string {
  if (!mins) return "—";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const LEAVE_TYPES: { value: LeaveType; label: string }[] = [
  { value: "annual", label: "Annual Leave" },
  { value: "sick", label: "Sick Leave" },
  { value: "unpaid", label: "Unpaid Leave" },
  { value: "personal", label: "Personal Leave" },
  { value: "bereavement", label: "Bereavement" },
  { value: "public_holiday", label: "Public Holiday" },
];

export default function SchedulingScreen() {
  const { token } = useAuth();
  const { activeClub } = useActiveClub();
  const orgId = activeClub?.id;
  const baseUrl = process.env.EXPO_PUBLIC_DOMAIN ? `https://${process.env.EXPO_PUBLIC_DOMAIN}` : "";

  const [tab, setTab] = useState<"shifts" | "leave" | "timesheets">("shifts");
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [leaveData, setLeaveData] = useState<MyLeaveData>({ requests: [], annualBalance: "0", sickBalance: "0" });
  const [timesheets, setTimesheets] = useState<TimesheetEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showLeaveModal, setShowLeaveModal] = useState(false);
  const [leaveForm, setLeaveForm] = useState<{ leaveType: LeaveType; startDate: string; endDate: string; totalDays: string; reason: string }>({
    leaveType: "annual", startDate: "", endDate: "", totalDays: "1", reason: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [clocking, setClocking] = useState(false);
  const [clockedIn, setClockedIn] = useState<{ entryId?: number; clockIn: string } | null>(null);

  const authHeader = { Authorization: `Bearer ${token}` };

  const fetchAll = useCallback(async () => {
    if (!orgId || !token) return;
    try {
      const today = new Date().toISOString().split("T")[0];
      const fromDate = today;
      const toDate = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];

      const [s, l, t] = await Promise.all([
        fetch(`${baseUrl}/api/organizations/${orgId}/scheduling/my-shifts?from=${fromDate}&to=${toDate}`, { headers: authHeader }),
        fetch(`${baseUrl}/api/organizations/${orgId}/scheduling/my-leave`, { headers: authHeader }),
        fetch(`${baseUrl}/api/organizations/${orgId}/scheduling/my-timesheets?from=${new Date(Date.now() - 60 * 86400000).toISOString().split("T")[0]}&to=${toDate}`, { headers: authHeader }),
      ]);

      if (!s.ok || !l.ok || !t.ok) { setError("Could not load scheduling data"); return; }

      const [shiftsData, leaveJson, tsData] = await Promise.all([s.json(), l.json(), t.json()]);
      setShifts(Array.isArray(shiftsData) ? shiftsData : []);
      setLeaveData(leaveJson);
      setTimesheets(Array.isArray(tsData) ? tsData : []);

      const todayTs = tsData.find((e: TimesheetEntry) => e.date === today && e.clockIn && !e.clockOut);
      setClockedIn(todayTs ? { clockIn: todayTs.clockIn! } : null);

      setError(null);
    } catch {
      setError("Failed to load data");
    }
  }, [orgId, token, baseUrl]);

  React.useEffect(() => {
    setLoading(true);
    fetchAll().finally(() => setLoading(false));
  }, [fetchAll]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  }, [fetchAll]);

  const handleClockIn = async () => {
    if (!orgId || !token) return;
    setClocking(true);
    try {
      const r = await fetch(`${baseUrl}/api/organizations/${orgId}/scheduling/timesheets/clock-in`, {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ date: new Date().toISOString().split("T")[0] }),
      });
      const data = await r.json();
      if (!r.ok) { Alert.alert("Error", data.error || "Clock-in failed"); return; }
      setClockedIn({ clockIn: data.clockIn });
      Alert.alert("Clocked In", `Clocked in at ${data.clockIn}`);
    } catch {
      Alert.alert("Error", "Network error");
    } finally {
      setClocking(false);
    }
  };

  const handleClockOut = async () => {
    if (!orgId || !token) return;
    setClocking(true);
    try {
      const r = await fetch(`${baseUrl}/api/organizations/${orgId}/scheduling/timesheets/clock-out`, {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ date: new Date().toISOString().split("T")[0] }),
      });
      const data = await r.json();
      if (!r.ok) { Alert.alert("Error", data.error || "Clock-out failed"); return; }
      setClockedIn(null);
      Alert.alert("Clocked Out", `Total: ${fmtMins(data.totalMinutes)}`);
      await fetchAll();
    } catch {
      Alert.alert("Error", "Network error");
    } finally {
      setClocking(false);
    }
  };

  const handleConfirmShift = async (shiftId: number) => {
    if (!orgId || !token) return;
    try {
      const r = await fetch(`${baseUrl}/api/organizations/${orgId}/scheduling/shifts/${shiftId}/confirm`, {
        method: "POST",
        headers: authHeader,
      });
      if (!r.ok) { Alert.alert("Error", "Could not confirm shift"); return; }
      setShifts((prev) => prev.map((s) => s.id === shiftId ? { ...s, status: "confirmed" as ShiftStatus } : s));
    } catch {
      Alert.alert("Error", "Network error");
    }
  };

  const handleSubmitLeave = async () => {
    if (!orgId || !token || !leaveForm.startDate || !leaveForm.endDate) {
      Alert.alert("Error", "Please fill in all required fields");
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch(`${baseUrl}/api/organizations/${orgId}/scheduling/leave`, {
        method: "POST",
        headers: { ...authHeader, "Content-Type": "application/json" },
        body: JSON.stringify(leaveForm),
      });
      const data = await r.json();
      if (!r.ok) { Alert.alert("Error", data.error || "Submit failed"); return; }
      setShowLeaveModal(false);
      Alert.alert("Success", "Leave request submitted");
      await fetchAll();
    } catch {
      Alert.alert("Error", "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelLeave = async (leaveId: number) => {
    if (!orgId || !token) return;
    Alert.alert("Cancel Leave", "Are you sure you want to cancel this leave request?", [
      { text: "No", style: "cancel" },
      { text: "Yes", style: "destructive", onPress: async () => {
        const r = await fetch(`${baseUrl}/api/organizations/${orgId}/scheduling/leave/${leaveId}/cancel`, { method: "PATCH", headers: authHeader });
        if (r.ok) { await fetchAll(); }
      }},
    ]);
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <LoadingSpinner size="large" color={PRIMARY} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={["top", "left", "right"]}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>My Schedule</Text>
          <Text style={styles.headerSub}>Shifts, leave & timesheets</Text>
        </View>
        <View style={styles.clockRow}>
          {clockedIn ? (
            <TouchableOpacity style={[styles.clockBtn, styles.clockOutBtn]} onPress={handleClockOut} disabled={clocking}>
              {clocking ? <LoadingSpinner size="small" color="#fff" /> : (
                <>
                  <Feather name="log-out" size={14} color="#fff" />
                  <Text style={styles.clockBtnText}>Clock Out</Text>
                </>
              )}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={[styles.clockBtn, styles.clockInBtn]} onPress={handleClockIn} disabled={clocking}>
              {clocking ? <LoadingSpinner size="small" color="#fff" /> : (
                <>
                  <Feather name="log-in" size={14} color="#fff" />
                  <Text style={styles.clockBtnText}>Clock In</Text>
                </>
              )}
            </TouchableOpacity>
          )}
        </View>
      </View>

      {clockedIn && (
        <View style={styles.clockedInBanner}>
          <Feather name="clock" size={14} color={PRIMARY} />
          <Text style={styles.clockedInText}>Clocked in at {clockedIn.clockIn}</Text>
        </View>
      )}

      {/* Tabs */}
      <View style={styles.tabs}>
        {(["shifts", "leave", "timesheets"] as const).map((t) => (
          <TouchableOpacity key={t} style={[styles.tab, tab === t && styles.tabActive]} onPress={() => setTab(t)}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === "shifts" ? "Shifts" : t === "leave" ? "Leave" : "Timesheets"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView style={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={PRIMARY} />}>
        {error && (
          <View style={styles.errorBanner}>
            <Feather name="alert-circle" size={14} color="#ef4444" />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {/* ── SHIFTS ── */}
        {tab === "shifts" && (
          <View style={styles.section}>
            {shifts.length === 0 ? (
              <View style={styles.empty}><Feather name="calendar" size={32} color="#444" /><Text style={styles.emptyText}>No upcoming shifts</Text></View>
            ) : shifts.map((s) => (
              <View key={s.id} style={styles.card}>
                <View style={styles.cardHeader}>
                  <View style={[styles.deptDot, { backgroundColor: DEPT_COLORS[s.department] || "#6b7280" }]} />
                  <Text style={styles.cardTitle}>{DEPT_LABELS[s.department] || s.department}</Text>
                  <View style={[styles.statusBadge, { backgroundColor: SHIFT_STATUS_COLORS[s.status] + "30" }]}>
                    <Text style={[styles.statusText, { color: SHIFT_STATUS_COLORS[s.status] }]}>{s.status}</Text>
                  </View>
                </View>
                <Text style={styles.cardDate}>{s.date}</Text>
                <Text style={styles.cardTime}>{s.startTime} – {s.endTime}</Text>
                {s.role && <Text style={styles.cardRole}>{s.role}</Text>}
                {s.notes && <Text style={styles.cardNotes}>{s.notes}</Text>}
                {s.status === "published" && (
                  <TouchableOpacity style={styles.confirmBtn} onPress={() => handleConfirmShift(s.id)}>
                    <Feather name="check-circle" size={14} color="#22c55e" />
                    <Text style={styles.confirmBtnText}>Confirm Shift</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}
          </View>
        )}

        {/* ── LEAVE ── */}
        {tab === "leave" && (
          <View style={styles.section}>
            <View style={styles.balanceRow}>
              <View style={styles.balanceCard}>
                <Text style={styles.balanceLabel}>Annual Leave</Text>
                <Text style={styles.balanceValue}>{leaveData.annualBalance} days</Text>
              </View>
              <View style={styles.balanceCard}>
                <Text style={styles.balanceLabel}>Sick Leave</Text>
                <Text style={styles.balanceValue}>{leaveData.sickBalance} days</Text>
              </View>
            </View>
            <TouchableOpacity style={styles.addLeaveBtn} onPress={() => setShowLeaveModal(true)}>
              <Feather name="plus" size={16} color="#fff" />
              <Text style={styles.addLeaveBtnText}>Request Leave</Text>
            </TouchableOpacity>
            {leaveData.requests.length === 0 ? (
              <View style={styles.empty}><Feather name="file-text" size={32} color="#444" /><Text style={styles.emptyText}>No leave requests</Text></View>
            ) : leaveData.requests.map((l) => (
              <View key={l.id} style={styles.card}>
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>{l.leaveType.replace("_", " ")}</Text>
                  <View style={[styles.statusBadge, { backgroundColor: LEAVE_STATUS_COLORS[l.status] + "30" }]}>
                    <Text style={[styles.statusText, { color: LEAVE_STATUS_COLORS[l.status] }]}>{l.status}</Text>
                  </View>
                </View>
                <Text style={styles.cardDate}>{l.startDate} → {l.endDate} · {l.totalDays} day{Number(l.totalDays) !== 1 ? "s" : ""}</Text>
                {l.reason && <Text style={styles.cardNotes}>{l.reason}</Text>}
                {l.reviewNotes && <Text style={[styles.cardNotes, { color: "#f59e0b" }]}>Manager note: {l.reviewNotes}</Text>}
                {l.status === "pending" && (
                  <TouchableOpacity style={styles.cancelLeaveBtn} onPress={() => handleCancelLeave(l.id)}>
                    <Text style={styles.cancelLeaveBtnText}>Cancel Request</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}
          </View>
        )}

        {/* ── TIMESHEETS ── */}
        {tab === "timesheets" && (
          <View style={styles.section}>
            {timesheets.length === 0 ? (
              <View style={styles.empty}><Ionicons name="time-outline" size={32} color="#444" /><Text style={styles.emptyText}>No timesheet records</Text></View>
            ) : timesheets.map((t) => (
              <View key={t.id} style={styles.card}>
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>{t.date}</Text>
                  <View style={[styles.statusBadge, { backgroundColor: t.isApproved ? "#22c55e30" : "#f59e0b30" }]}>
                    <Text style={[styles.statusText, { color: t.isApproved ? "#22c55e" : "#f59e0b" }]}>{t.isApproved ? "Approved" : "Pending"}</Text>
                  </View>
                </View>
                <View style={styles.tsRow}>
                  <View style={styles.tsCell}>
                    <Text style={styles.tsLabel}>Clock In</Text>
                    <Text style={styles.tsValue}>{t.clockIn ?? "—"}</Text>
                  </View>
                  <View style={styles.tsCell}>
                    <Text style={styles.tsLabel}>Clock Out</Text>
                    <Text style={styles.tsValue}>{t.clockOut ?? "—"}</Text>
                  </View>
                  <View style={styles.tsCell}>
                    <Text style={styles.tsLabel}>Total</Text>
                    <Text style={styles.tsValue}>{fmtMins(t.totalMinutes)}</Text>
                  </View>
                  {(t.overtimeMinutes ?? 0) > 0 && (
                    <View style={styles.tsCell}>
                      <Text style={styles.tsLabel}>OT</Text>
                      <Text style={[styles.tsValue, { color: GOLD }]}>{fmtMins(t.overtimeMinutes)}</Text>
                    </View>
                  )}
                </View>
                {t.isManualEntry && <Text style={styles.manualBadge}>Manual entry</Text>}
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {/* ── LEAVE REQUEST MODAL ── */}
      <Modal visible={showLeaveModal} animationType="slide" presentationStyle="pageSheet">
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Request Leave</Text>
            <TouchableOpacity onPress={() => setShowLeaveModal(false)}>
              <Feather name="x" size={24} color="#fff" />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.modalBody}>
            <Text style={styles.fieldLabel}>Leave Type</Text>
            <View style={styles.leaveTypeRow}>
              {LEAVE_TYPES.map((lt) => (
                <TouchableOpacity key={lt.value} style={[styles.leaveTypeChip, leaveForm.leaveType === lt.value && styles.leaveTypeChipActive]} onPress={() => setLeaveForm((f) => ({ ...f, leaveType: lt.value }))}>
                  <Text style={[styles.leaveTypeText, leaveForm.leaveType === lt.value && styles.leaveTypeTextActive]}>{lt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.fieldLabel}>Start Date *</Text>
            <TextInput style={styles.input} placeholder="YYYY-MM-DD" placeholderTextColor="#555" value={leaveForm.startDate} onChangeText={(v) => setLeaveForm((f) => ({ ...f, startDate: v }))} />
            <Text style={styles.fieldLabel}>End Date *</Text>
            <TextInput style={styles.input} placeholder="YYYY-MM-DD" placeholderTextColor="#555" value={leaveForm.endDate} onChangeText={(v) => setLeaveForm((f) => ({ ...f, endDate: v }))} />
            <Text style={styles.fieldLabel}>Total Days *</Text>
            <TextInput style={styles.input} placeholder="1" placeholderTextColor="#555" keyboardType="decimal-pad" value={leaveForm.totalDays} onChangeText={(v) => setLeaveForm((f) => ({ ...f, totalDays: v }))} />
            <Text style={styles.fieldLabel}>Reason (optional)</Text>
            <TextInput style={[styles.input, { height: 80, textAlignVertical: "top" }]} placeholder="Brief reason for leave…" placeholderTextColor="#555" multiline value={leaveForm.reason} onChangeText={(v) => setLeaveForm((f) => ({ ...f, reason: v }))} />
          </ScrollView>
          <TouchableOpacity style={[styles.submitBtn, submitting && { opacity: 0.6 }]} onPress={handleSubmitLeave} disabled={submitting}>
            {submitting ? <LoadingSpinner size="small" color="#fff" /> : <Text style={styles.submitBtnText}>Submit Request</Text>}
          </TouchableOpacity>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16, borderBottomWidth: 1, borderBottomColor: Colors.border },
  headerTitle: { fontSize: 22, fontWeight: "700", color: "#fff" },
  headerSub: { fontSize: 12, color: "#888", marginTop: 2 },
  clockRow: { flexDirection: "row", gap: 8 },
  clockBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20 },
  clockInBtn: { backgroundColor: PRIMARY },
  clockOutBtn: { backgroundColor: "#ef4444" },
  clockBtnText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  clockedInBanner: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: PRIMARY + "15" },
  clockedInText: { color: PRIMARY, fontSize: 13, fontWeight: "500" },
  tabs: { flexDirection: "row", paddingHorizontal: 16, paddingVertical: 8, gap: 8, borderBottomWidth: 1, borderBottomColor: Colors.border },
  tab: { flex: 1, paddingVertical: 8, borderRadius: 20, alignItems: "center", backgroundColor: Colors.surface },
  tabActive: { backgroundColor: PRIMARY },
  tabText: { color: "#888", fontWeight: "500", fontSize: 13 },
  tabTextActive: { color: "#fff" },
  content: { flex: 1 },
  section: { padding: 16, gap: 12 },
  errorBanner: { flexDirection: "row", alignItems: "center", gap: 8, margin: 16, padding: 12, backgroundColor: "#ef444420", borderRadius: 10 },
  errorText: { color: "#ef4444", fontSize: 13 },
  empty: { alignItems: "center", paddingVertical: 48, gap: 12 },
  emptyText: { color: "#555", fontSize: 15 },
  card: { backgroundColor: Colors.surface, borderRadius: 14, padding: 14, gap: 6, borderWidth: 1, borderColor: Colors.border },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  deptDot: { width: 10, height: 10, borderRadius: 5 },
  cardTitle: { fontSize: 15, fontWeight: "600", color: "#fff", flex: 1 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12 },
  statusText: { fontSize: 11, fontWeight: "600" },
  cardDate: { fontSize: 13, color: "#888" },
  cardTime: { fontSize: 14, color: "#ccc", fontWeight: "500" },
  cardRole: { fontSize: 13, color: PRIMARY, fontStyle: "italic" },
  cardNotes: { fontSize: 12, color: "#888" },
  confirmBtn: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", marginTop: 4, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: "#22c55e20", borderRadius: 20, borderWidth: 1, borderColor: "#22c55e40" },
  confirmBtnText: { color: "#22c55e", fontSize: 13, fontWeight: "600" },
  balanceRow: { flexDirection: "row", gap: 12, marginBottom: 4 },
  balanceCard: { flex: 1, backgroundColor: Colors.surface, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: Colors.border, alignItems: "center" },
  balanceLabel: { fontSize: 12, color: "#888", marginBottom: 4 },
  balanceValue: { fontSize: 22, fontWeight: "700", color: "#fff" },
  addLeaveBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, padding: 12, backgroundColor: PRIMARY, borderRadius: 12, marginBottom: 4 },
  addLeaveBtnText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  cancelLeaveBtn: { alignSelf: "flex-start", marginTop: 4, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: "#ef444420", borderRadius: 20, borderWidth: 1, borderColor: "#ef444440" },
  cancelLeaveBtnText: { color: "#ef4444", fontSize: 13, fontWeight: "600" },
  tsRow: { flexDirection: "row", gap: 12, marginTop: 4 },
  tsCell: { alignItems: "center" },
  tsLabel: { fontSize: 11, color: "#888" },
  tsValue: { fontSize: 14, fontWeight: "600", color: "#fff" },
  manualBadge: { fontSize: 11, color: "#888", fontStyle: "italic" },
  modalContainer: { flex: 1, backgroundColor: Colors.background },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16, borderBottomWidth: 1, borderBottomColor: Colors.border },
  modalTitle: { fontSize: 20, fontWeight: "700", color: "#fff" },
  modalBody: { flex: 1, padding: 16 },
  fieldLabel: { fontSize: 13, color: "#888", marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: Colors.surface, borderRadius: 10, padding: 12, color: "#fff", borderWidth: 1, borderColor: Colors.border, fontSize: 15 },
  leaveTypeRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  leaveTypeChip: { paddingHorizontal: 12, paddingVertical: 7, backgroundColor: Colors.surface, borderRadius: 20, borderWidth: 1, borderColor: Colors.border },
  leaveTypeChipActive: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  leaveTypeText: { color: "#888", fontSize: 13 },
  leaveTypeTextActive: { color: "#fff", fontWeight: "600" },
  submitBtn: { margin: 16, padding: 15, backgroundColor: PRIMARY, borderRadius: 12, alignItems: "center" },
  submitBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
